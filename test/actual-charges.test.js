// Actual charges: what the provider really billed for a job, as opposed to the estimate made
// before submitting. Kie reports `creditsConsumed` on a finished job (1 credit = $0.005); the
// other providers report nothing, so their jobs keep only an estimate.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS } from '../src/providers/index.js';
import { createFakeFetch } from './helpers/fake-fetch.js';
import { createEnvironment, keysFor, runArgs, approx } from './helpers/harness.js';
import { routesFor, fixture } from './helpers/providers.js';

const MINI = ['seedance-2.0-mini', '--res', '480p'];
const JOB = 'kie:task_kie_001';
const STATUS_URL = 'https://api.kie.ai/api/v1/jobs/recordInfo';

/** A recorded Kie status response with some `data` fields replaced. A value of `undefined`
 *  removes the field. */
function kieStatus(base, data = {}) {
  const j = fixture('kie', `status-${base}`);
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) delete j.data[k]; else j.data[k] = v;
  }
  return j;
}

/** Full set of routes for a Kie job whose status endpoint answers with `status`. */
function kieRoutesWith(status) {
  const routes = routesFor({ kie: {} });
  const poll = routes.find((r) => r.url === STATUS_URL);
  poll.responses = [{ status: 200, json: status }];
  return routes;
}

async function adapterStatus(json) {
  const fake = createFakeFetch([{ method: 'GET', url: STATUS_URL, status: 200, json }]);
  const ctx = { key: 'test-key-ZZZZ9999', fetch: fake.fetch, now: () => new Date('2026-11-21T12:00:00Z'), sleep: async () => {} };
  return ADAPTERS.kie.status('task_kie_001', ctx);
}

describe('kie adapter: the charge behind a finished job', () => {
  test('a succeeded job is charged its credits at $0.005 each', async () => {
    const s = await adapterStatus(fixture('kie', 'status-success'));
    assert.equal(s.state, 'succeeded');
    approx(s.actualUsd, 0.076);
  });

  test('a failed job that consumed 0 credits was charged $0', async () => {
    const s = await adapterStatus(fixture('kie', 'status-fail'));
    assert.equal(s.state, 'failed');
    assert.equal(s.actualUsd, 0);
  });

  test('a failed job that consumed credits reports that charge', async () => {
    const s = await adapterStatus(kieStatus('fail', { creditsConsumed: 15.2 }));
    assert.equal(s.state, 'failed');
    approx(s.actualUsd, 0.076);
  });

  test('a job that is still waiting has no charge yet, even if credits are shown', async () => {
    const s = await adapterStatus(kieStatus('waiting', { creditsConsumed: 3.6 }));
    assert.equal(s.state, 'queued');
    assert.equal('actualUsd' in s, false);
  });

  test('a running job has no charge yet, even if credits are shown', async () => {
    const s = await adapterStatus(kieStatus('generating', { creditsConsumed: 3.6 }));
    assert.equal(s.state, 'running');
    assert.equal('actualUsd' in s, false);
  });

  for (const [label, value] of [['missing', undefined], ['null', null], ['negative', -1], ['a string', '15.2'], ['NaN-like text', 'abc'], ['an object', {}]]) {
    test(`creditsConsumed that is ${label} gives no charge`, async () => {
      const s = await adapterStatus(kieStatus('success', { creditsConsumed: value }));
      assert.equal(s.state, 'succeeded');
      assert.equal('actualUsd' in s, false);
    });
  }

  test('a succeeded job reporting 0 credits has an unknown charge, not a free one', async () => {
    const s = await adapterStatus(kieStatus('success', { creditsConsumed: 0 }));
    assert.equal(s.state, 'succeeded');
    assert.equal('actualUsd' in s, false);
  });
});

describe('run --wait with a known charge', () => {
  test('the finished spend line and the JSON result carry actualUsd; the estimate stays', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['success'] } }) });
    const r = await e.run(runArgs(...MINI, '--duration', '5', '--wait'));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const finished = e.spendLines().find((l) => l.event === 'finished');
    approx(finished.actualUsd, 0.076);
    approx(r.json.actualUsd, 0.076);
    approx(r.json.estimateUsd, 0.095);
  });

  test('text output shows the charge and still shows the estimate', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['success'] } }) });
    const r = await e.run(['run', ...MINI, '--duration', '5', '--prompt', 'a calm lake', '--wait']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Charged: \$0\.0760/);
    assert.match(r.stdout, /Estimate: \$0\.0950/);
  });
});

describe('run --wait with an unknown charge', () => {
  const unknown = () => kieStatus('success', { creditsConsumed: undefined });

  test('no actualUsd key in the finished line or the JSON result', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: kieRoutesWith(unknown()) });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const finished = e.spendLines().find((l) => l.event === 'finished');
    assert.equal(finished.state, 'succeeded');
    assert.equal('actualUsd' in finished, false);
    assert.equal('actualUsd' in r.json, false);
  });

  test('text output has an Estimate line and no Charged line', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: kieRoutesWith(unknown()) });
    const r = await e.run(['run', ...MINI, '--prompt', 'a calm lake', '--wait']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Estimate:/);
    assert.doesNotMatch(r.stdout, /Charged:/);
  });
});

describe('failed jobs say whether they were charged', () => {
  test('a failed job with 0 credits: logged as $0, exit 6, "not charged"', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['fail'] } }) });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 6, `${r.stdout}\n${r.stderr}`);
    const finished = e.spendLines().find((l) => l.event === 'finished');
    assert.equal(finished.state, 'failed');
    assert.equal(finished.actualUsd, 0);
    assert.match(r.error.message, /not charged/i);
  });

  test('a failed job that was charged says how much', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: kieRoutesWith(kieStatus('fail', { creditsConsumed: 15.2 })) });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 6, `${r.stdout}\n${r.stderr}`);
    approx(e.spendLines().find((l) => l.event === 'finished').actualUsd, 0.076);
    assert.match(r.error.message, /charged \$0\.0760/i);
    assert.doesNotMatch(r.error.message, /not charged/i);
  });

  test('a failed job with an unknown charge claims neither', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: kieRoutesWith(kieStatus('fail', { creditsConsumed: undefined })) });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 6, `${r.stdout}\n${r.stderr}`);
    assert.equal('actualUsd' in e.spendLines().find((l) => l.event === 'finished'), false);
    assert.doesNotMatch(r.error.message, /charged/i);
  });
});

describe('wait and status show the charge', () => {
  test('wait --json includes actualUsd; wait text says "Charged: $0.0760"', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['success'] } }) });
    const j = await e.run(['wait', JOB, '--json']);
    assert.equal(j.code, 0, `${j.stdout}\n${j.stderr}`);
    approx(j.json.actualUsd, 0.076);
    e.setRoutes(routesFor({ kie: { states: ['success'] } }));
    const r = await e.run(['wait', JOB]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Charged: \$0\.0760/);
  });

  test('status --json includes actualUsd; status text says "Charged: $0.0760"', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['success'] } }) });
    const j = await e.run(['status', JOB, '--json']);
    approx(j.json.actualUsd, 0.076);
    e.setRoutes(routesFor({ kie: { states: ['success'] } }));
    const r = await e.run(['status', JOB]);
    assert.match(r.stdout, /Charged: \$0\.0760/);
  });

  test('status of a job with an unknown charge has no actualUsd and no Charged line', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: kieRoutesWith(kieStatus('success', { creditsConsumed: undefined })) });
    const j = await e.run(['status', JOB, '--json']);
    assert.equal('actualUsd' in j.json, false);
    e.setRoutes(kieRoutesWith(kieStatus('success', { creditsConsumed: undefined })));
    const r = await e.run(['status', JOB]);
    assert.doesNotMatch(r.stdout, /Charged:/);
  });

  test('status of a failed, uncharged job says it was not charged', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['fail'] } }) });
    const j = await e.run(['status', JOB, '--json']);
    assert.equal(j.json.state, 'failed');
    assert.equal(j.json.actualUsd, 0);
    e.setRoutes(routesFor({ kie: { states: ['fail'] } }));
    const r = await e.run(['status', JOB]);
    assert.match(r.stdout, /not charged/i);
  });

  test('status of a job still waiting shows no charge', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: kieRoutesWith(kieStatus('waiting', { creditsConsumed: 3.6 })) });
    const j = await e.run(['status', JOB, '--json']);
    assert.equal('actualUsd' in j.json, false);
  });

  test('wait on a failed, uncharged job says it was not charged (exit 6)', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['fail'] } }) });
    const r = await e.run(['wait', JOB]);
    assert.equal(r.code, 6);
    assert.match(r.stderr, /not charged/i);
  });
});

describe('spend: charged amounts replace estimates', () => {
  const sub = (job, estimateUsd, at = '2026-11-21T10:00:00Z') =>
    ({ at, event: 'submitted', job, model: 'seedance-2.0-mini', params: {}, estimateUsd, priceSource: 'bundled' });
  const fin = (job, state, extra = {}, at = '2026-11-21T10:05:00Z') => ({ at, event: 'finished', job, state, files: [], ...extra });

  const lines = [
    sub('kie:billed_ok', 0.6), fin('kie:billed_ok', 'succeeded', { actualUsd: 0.5 }),
    sub('kie:failed_free', 0.076), fin('kie:failed_free', 'failed', { actualUsd: 0 }),
    sub('kie:finished_no_charge', 0.25), fin('kie:finished_no_charge', 'succeeded'),
    sub('kie:unfinished', 0.25),
    sub('kie:no_price', null), fin('kie:no_price', 'succeeded'),
    sub('kie:unpriced_but_billed', null), fin('kie:unpriced_but_billed', 'succeeded', { actualUsd: 0.25 }),
  ];
  const byJob = (json, id) => json.jobs.find((j) => j.job === id);

  test('each job reports estimateUsd and actualUsd (number or null)', async (t) => {
    const e = createEnvironment(t);
    e.writeSpendLines(lines);
    const s = (await e.run(['spend', '--json'])).json;
    assert.equal(s.jobs.length, 6);
    approx(byJob(s, 'kie:billed_ok').estimateUsd, 0.6);
    approx(byJob(s, 'kie:billed_ok').actualUsd, 0.5);
    approx(byJob(s, 'kie:failed_free').estimateUsd, 0.076);
    assert.equal(byJob(s, 'kie:failed_free').actualUsd, 0);
    approx(byJob(s, 'kie:finished_no_charge').estimateUsd, 0.25);
    assert.equal(byJob(s, 'kie:finished_no_charge').actualUsd, null);
    assert.equal(byJob(s, 'kie:unfinished').actualUsd, null);
    assert.equal(byJob(s, 'kie:no_price').estimateUsd, null);
    assert.equal(byJob(s, 'kie:no_price').actualUsd, null);
    assert.equal(byJob(s, 'kie:unpriced_but_billed').estimateUsd, null);
    approx(byJob(s, 'kie:unpriced_but_billed').actualUsd, 0.25);
  });

  test('totals: charges where known, estimates otherwise, a free failed job adds nothing', async (t) => {
    const e = createEnvironment(t);
    e.writeSpendLines(lines);
    const s = (await e.run(['spend', '--json'])).json;
    approx(s.chargedUsd, 0.75); // 0.5 + 0 + 0.25
    approx(s.estimatedUsd, 0.5); // finished_no_charge 0.25 + unfinished 0.25
    approx(s.totalUsd, 1.25);
    approx(s.totalUsd, s.chargedUsd + s.estimatedUsd);
    assert.equal(s.unknownEstimates, 1); // only the job with neither price
  });

  test('text output marks each row charged or estimate, and shows the total', async (t) => {
    const e = createEnvironment(t);
    e.writeSpendLines(lines);
    const r = await e.run(['spend']);
    assert.equal(r.code, 0, r.stderr);
    const row = (id) => r.stdout.split('\n').find((l) => l.includes(id)) ?? '';
    for (const id of ['kie:billed_ok', 'kie:failed_free', 'kie:unpriced_but_billed']) {
      assert.match(row(id), /charged/, id);
      assert.doesNotMatch(row(id), /estimate/, id);
    }
    for (const id of ['kie:finished_no_charge', 'kie:unfinished']) {
      assert.match(row(id), /estimate/, id);
      assert.doesNotMatch(row(id), /charged/, id);
    }
    assert.match(row('kie:no_price'), /price unknown/);
    assert.match(r.stdout, /Total:.*\$1\.25/);
  });

  test('--since still filters, and totals follow the filter', async (t) => {
    const e = createEnvironment(t);
    e.writeSpendLines([
      sub('kie:old', 0.9, '2026-11-01T10:00:00Z'), fin('kie:old', 'succeeded', { actualUsd: 0.8 }, '2026-11-01T10:05:00Z'),
      sub('kie:new', 0.6), fin('kie:new', 'succeeded', { actualUsd: 0.5 }),
    ]);
    const s = (await e.run(['spend', '--since', '2026-11-20', '--json'])).json;
    assert.deepEqual(s.jobs.map((j) => j.job), ['kie:new']);
    approx(s.totalUsd, 0.5);
    approx(s.chargedUsd, 0.5);
    assert.equal(s.estimatedUsd, 0);
  });

  test('a charge recorded on one finished line survives a later finished line without one', async (t) => {
    const e = createEnvironment(t);
    e.writeSpendLines([sub('kie:j', 0.6), fin('kie:j', 'succeeded', { actualUsd: 0.5 }, '2026-11-21T10:05:00Z'),
      fin('kie:j', 'succeeded', {}, '2026-11-21T10:10:00Z')]);
    const s = (await e.run(['spend', '--json'])).json;
    assert.equal(s.jobs.length, 1);
    approx(s.jobs[0].actualUsd, 0.5);
    approx(s.totalUsd, 0.5);
  });

  test('a later finished line with a charge replaces the earlier one', async (t) => {
    const e = createEnvironment(t);
    e.writeSpendLines([sub('kie:j', 0.6), fin('kie:j', 'succeeded', { actualUsd: 0.5 }, '2026-11-21T10:05:00Z'),
      fin('kie:j', 'succeeded', { actualUsd: 0.4 }, '2026-11-21T10:10:00Z')]);
    const s = (await e.run(['spend', '--json'])).json;
    approx(s.jobs[0].actualUsd, 0.4);
    approx(s.totalUsd, 0.4);
  });

  for (const [label, bad] of [['a string', '0.5'], ['null', null], ['negative', -1], ['a boolean', true]]) {
    test(`a damaged actualUsd (${label}) in the log is treated as unknown`, async (t) => {
      const e = createEnvironment(t);
      e.writeSpendLines([sub('kie:j', 0.6), fin('kie:j', 'succeeded', { actualUsd: bad })]);
      const s = (await e.run(['spend', '--json'])).json;
      assert.equal(s.jobs[0].actualUsd, null);
      approx(s.totalUsd, 0.6);
      approx(s.estimatedUsd, 0.6);
      approx(s.chargedUsd, 0);
    });
  }
});

describe('other providers report no charge', () => {
  const states = { replicate: ['succeeded'], wavespeed: ['completed'], fal: ['completed'] };
  for (const id of Object.keys(states)) {
    test(`${id}: no actualUsd in the result or the finished line`, async (t) => {
      const e = createEnvironment(t, { env: keysFor(id), routes: routesFor(id, { states: states[id] }) });
      const r = await e.run(runArgs(...MINI, '--wait'));
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal('actualUsd' in r.json, false);
      assert.equal('actualUsd' in e.spendLines().find((l) => l.event === 'finished'), false);
    });
  }
});
