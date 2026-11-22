// Spend log (a submitted line on acceptance, a finished line at the end, the submitted line
// survives an unfinished job, `spend` joins by job id, prompts never logged), downloads
// (on --wait, --no-download, --download DIR), job ids, wait timeout = exit 7, status mapping,
// and a happy-path run --wait for every provider.
// Assumed shapes: status --json -> { state }, spend --json -> { totalUsd, jobs: [{ job, state, estimateUsd }] }.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEnvironment, keysFor, runArgs, approx, PROMPT } from './helpers/harness.js';
import { routesFor, submitCalls, FAKE_MEDIA_BYTES } from './helpers/providers.js';

const MINI = ['seedance-2.0-mini', '--res', '480p'];
const SECRET_PROMPT = 'SECRET-PROMPT-ZEBRA-42';

describe('happy path: run --wait works end to end for every provider', () => {
  const sequences = {
    kie: ['waiting', 'queuing', 'generating', 'success'],
    replicate: ['starting', 'processing', 'succeeded'],
    wavespeed: ['processing', 'completed'],
    fal: ['in-queue', 'in-progress', 'completed'],
  };
  for (const id of Object.keys(sequences)) {
    test(id, async (t) => {
      const e = createEnvironment(t, { env: keysFor(id), routes: routesFor(id, { states: sequences[id] }) });
      const r = await e.run(runArgs(...MINI, '--wait'));
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(submitCalls(e.calls, id).length, 1);

      const [submitted, finished, ...rest] = e.spendLines();
      assert.equal(rest.length, 0);
      assert.equal(submitted.event, 'submitted');
      assert.equal(finished.event, 'finished');
      assert.equal(submitted.job, finished.job, 'the two lines share the job id');
      assert.ok(submitted.job.startsWith(`${id}:`));
      assert.equal(finished.state, 'succeeded');

      // downloaded by default into ./cheapgen-out/
      assert.equal(finished.files.length, 1);
      const file = path.resolve(e.cwd, finished.files[0]);
      assert.ok(file.startsWith(path.join(e.cwd, 'cheapgen-out')), file);
      assert.equal(fs.readFileSync(file, 'utf8'), FAKE_MEDIA_BYTES);
    });
  }
});

describe('spend log', () => {
  test('submitted line carries time, model, parameters, estimate, price source and job id', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(runArgs(...MINI, '--duration', '5')); // no --wait
    assert.equal(r.code, 0, r.stderr);
    const lines = e.spendLines();
    assert.equal(lines.length, 1, 'only the submitted line exists until the job ends');
    const [s] = lines;
    assert.equal(s.event, 'submitted');
    assert.equal(s.job, r.json.job);
    assert.equal(s.job, 'kie:task_kie_001');
    assert.equal(s.model, 'seedance-2.0-mini');
    assert.equal(s.params.resolution, '480p');
    assert.equal(s.params.duration, 5);
    assert.equal(s.params.aspectRatio, '16:9');
    assert.equal(s.params.audio, true);
    approx(s.estimateUsd, 0.095);
    assert.equal(s.priceSource, 'bundled');
    assert.ok(!Number.isNaN(Date.parse(s.at)), `at should be a timestamp: ${s.at}`);
  });

  test('the submitted line is written when the job is accepted, before polling starts', async (t) => {
    // The status endpoint inspects the spend log at the moment it is called.
    let seenAtFirstPoll = null;
    const e = createEnvironment(t, { env: keysFor('kie') });
    const routes = routesFor({ kie: { states: ['success'] } });
    const poll = routes.find((x) => String(x.url).includes('recordInfo'));
    const original = poll.responses[0];
    poll.responses = [(req) => { seenAtFirstPoll ??= e.spendLines().map((l) => l.event); return original; }];
    e.setRoutes(routes);
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seenAtFirstPoll, ['submitted']);
  });

  test('if the job does not finish before the wait times out, the submitted line is still there (exit 7)', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating'] } }) });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`);
    const lines = e.spendLines();
    assert.equal(lines.filter((l) => l.event === 'submitted').length, 1);
    assert.equal(lines.find((l) => l.event === 'finished' && l.state === 'succeeded'), undefined);
    assert.match(`${r.stdout}${r.stderr}`, /kie:task_kie_001/, 'the job id is printed so `wait` can continue');
  });

  test('a later `wait <job>` finishes the job; spend joins submitted and finished by job id', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating'] } }) });
    await e.run(runArgs(...MINI, '--wait'));
    e.setRoutes(routesFor({ kie: { states: ['success'] } }));
    const w = await e.run(['wait', 'kie:task_kie_001', '--json']);
    assert.equal(w.code, 0, `${w.stdout}\n${w.stderr}`);
    const events = e.spendLines().map((l) => l.event);
    assert.equal(events.filter((x) => x === 'submitted').length, 1, 'wait does not log a second submission');
    assert.equal(events.filter((x) => x === 'finished').length, 1);

    const s = await e.run(['spend', '--json']);
    assert.equal(s.code, 0, s.stderr);
    assert.equal(s.json.jobs.length, 1, 'one job, not two lines');
    assert.equal(s.json.jobs[0].job, 'kie:task_kie_001');
    assert.equal(s.json.jobs[0].state, 'succeeded');
    // The recorded success response reports 15.2 credits ($0.076), which replaces the 5-second estimate.
    approx(s.json.totalUsd, 0.076);
    approx(s.json.jobs[0].estimateUsd, 0.095);
  });

  test('prompts are never written to the spend log', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    await e.run(['run', ...MINI, '--prompt', SECRET_PROMPT, '--wait', '--json']);
    assert.ok(e.spendLines().length >= 2);
    assert.ok(!e.spendText().includes(SECRET_PROMPT));
    assert.ok(!e.spendText().includes(PROMPT));
  });

  test('spend lists unfinished jobs, totals the estimates and honours --since', async (t) => {
    const e = createEnvironment(t);
    e.writeSpendLines([
      { at: '2026-11-01T10:00:00Z', event: 'submitted', job: 'kie:old_1', model: 'seedance-2.0-mini', params: {}, estimateUsd: 0.5, priceSource: 'bundled' },
      { at: '2026-11-01T10:01:00Z', event: 'finished', job: 'kie:old_1', state: 'succeeded', files: [] },
      { at: '2026-11-21T10:00:00Z', event: 'submitted', job: 'kie:new_1', model: 'seedance-2.0-mini', params: {}, estimateUsd: 0.095, priceSource: 'live' },
      { at: '2026-11-21T10:01:00Z', event: 'finished', job: 'kie:new_1', state: 'succeeded', files: [] },
      { at: '2026-11-21T11:00:00Z', event: 'submitted', job: 'replicate:new_2', model: 'seedance-2.0', params: {}, estimateUsd: 0.2, priceSource: 'bundled' },
    ]);
    const all = await e.run(['spend', '--json']);
    assert.equal(all.json.jobs.length, 3);
    approx(all.json.totalUsd, 0.795);
    const since = await e.run(['spend', '--since', '2026-11-20', '--json']);
    assert.equal(since.json.jobs.length, 2);
    approx(since.json.totalUsd, 0.295);
    const unfinished = since.json.jobs.find((j) => j.job === 'replicate:new_2');
    assert.notEqual(unfinished.state, 'succeeded', 'a submitted job with no finished line is not reported as done');
  });
});

describe('downloads', () => {
  test('--no-download keeps only the link; the spend log has no files', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(runArgs(...MINI, '--wait', '--no-download'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(e.cwd, 'cheapgen-out')), false);
    assert.equal(e.calls.filter((c) => c.url.includes('cdn.cheapgen-test.example')).length, 0);
    assert.match(`${r.stdout}`, /https:\/\/cdn\.cheapgen-test\.example\/out\/kie-1\.mp4/);
    const finished = e.spendLines().find((l) => l.event === 'finished');
    assert.equal(finished.state, 'succeeded');
    assert.deepEqual(finished.files ?? [], []);
  });

  test('--download DIR puts files in DIR and the spend log records the local path', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const dir = path.join(e.cwd, 'my-videos');
    const r = await e.run(runArgs(...MINI, '--wait', '--download', dir));
    assert.equal(r.code, 0, r.stderr);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('seedance-2.0-mini-'), files[0]);
    assert.ok(files[0].endsWith('.mp4'));
    const finished = e.spendLines().find((l) => l.event === 'finished');
    assert.equal(path.resolve(e.cwd, finished.files[0]), path.join(dir, files[0]));
  });

  test('existing files are never overwritten', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const dir = path.join(e.cwd, 'out');
    await e.run(runArgs(...MINI, '--wait', '--download', dir));
    e.setRoutes(routesFor({ kie: {} }));
    await e.run(runArgs(...MINI, '--wait', '--download', dir));
    assert.equal(fs.readdirSync(dir).length, 2, 'two runs, two files (same second, same model)');
  });

  test('without --wait nothing is downloaded', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    await e.run(runArgs(...MINI));
    assert.equal(fs.existsSync(path.join(e.cwd, 'cheapgen-out')), false);
  });
});

describe('status and wait', () => {
  const kieStates = [['waiting', 'queued'], ['queuing', 'queued'], ['generating', 'running'], ['success', 'succeeded'], ['fail', 'failed']];
  for (const [native, normalized] of kieStates) {
    test(`kie ${native} -> ${normalized}`, async (t) => {
      const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: [native] } }) });
      const r = await e.run(['status', 'kie:task_kie_001', '--json']);
      assert.equal(r.json.state, normalized);
    });
  }
  const repStates = [['starting', 'queued'], ['processing', 'running'], ['succeeded', 'succeeded'], ['failed', 'failed'], ['canceled', 'cancelled']];
  for (const [native, normalized] of repStates) {
    test(`replicate ${native} -> ${normalized}`, async (t) => {
      const e = createEnvironment(t, { env: keysFor('replicate'), routes: routesFor({ replicate: { states: [native] } }) });
      const r = await e.run(['status', 'replicate:rep_pred_001', '--json']);
      assert.equal(r.json.state, normalized);
    });
  }

  test('the provider prefix of the job id picks the adapter: only that provider is contacted', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ replicate: { states: ['processing'] } }) });
    const r = await e.run(['status', 'replicate:rep_pred_001', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(e.calls.every((c) => c.url.startsWith('https://api.replicate.com/')));
  });

  test('a malformed or unknown-provider job id is a usage error (code 2) with no network call', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie') });
    assert.equal((await e.run(['status', 'no-colon-here'])).code, 2);
    assert.equal((await e.run(['status', 'bogus:abc'])).code, 2);
    assert.equal(e.calls.length, 0);
  });

  test('status for a provider without a key fails and names the variable', async (t) => {
    const e = createEnvironment(t, { env: keysFor('replicate') });
    const r = await e.run(['status', 'kie:task_1']);
    assert.notEqual(r.code, 0);
    assert.match(`${r.stdout}${r.stderr}`, /KIE_API_KEY/);
  });
});
