// Safety: a cost limit or unknown price needs --yes/--max-cost (exit 4, nothing submitted);
// --dry-run sends no generation or upload request and prints provider, request and estimate;
// every submit body carries explicit resolution, duration, aspect and audio.
// Assumed run/dry-run --json shape: { provider, estimateUsd, request }, where `request` holds
// the provider-specific request (method, url, body). Explicit values are checked by scanning
// leaf values of the body, since each provider names its fields differently.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEnvironment, keysFor, runArgs, approx, leafValues } from './helpers/harness.js';
import { routesFor, submitCalls, providerOfCall } from './helpers/providers.js';

const MINI = ['seedance-2.0-mini', '--res', '480p'];
const BIG = ['seedance-2.0', '--res', '720p', '--duration', '15'];   // kie 0.205*15 = 3.075 > default 1.00
const FLASH = ['seedance-2.5-flash', '--res', '480p'];

describe('cost limit', () => {
  const setup = (t, userConfig) => createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }), userConfig });

  test('an estimate above the default $1.00 limit exits 4 and submits nothing', async (t) => {
    const e = setup(t);
    const r = await e.run(runArgs(...BIG));
    assert.equal(r.code, 4);
    assert.equal(submitCalls(e.calls).length, 0);
    assert.equal(e.spendLines().length, 0);
  });

  test('the limit in config is honoured', async (t) => {
    const e = setup(t, { maxCostPerRun: 0.10 });
    const r = await e.run(runArgs(...MINI, '--duration', '5')); // 0.095 passes
    assert.equal(r.code, 0, r.stderr);
    const over = await e.run(runArgs('seedance-2.0-mini', '--res', '720p')); // 0.205 fails
    assert.equal(over.code, 4);
    assert.equal(submitCalls(e.calls).length, 1);
  });

  test('--yes lets an over-limit run start', async (t) => {
    const e = setup(t);
    const r = await e.run(runArgs(...BIG, '--yes'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(submitCalls(e.calls, 'kie').length, 1);
  });

  test('--max-cost raises the limit for one run (and lowers it when smaller)', async (t) => {
    const e = setup(t);
    assert.equal((await e.run(runArgs(...BIG, '--max-cost', '5'))).code, 0);
    assert.equal((await e.run(runArgs(...BIG))).code, 4, 'the next run is back to the config limit');
    const lower = await e.run(runArgs('seedance-2.0-mini', '--res', '720p', '--max-cost', '0.10'));
    assert.equal(lower.code, 4);
    assert.equal(submitCalls(e.calls).length, 1);
  });

  test('an estimate exactly at the limit is allowed', async (t) => {
    const e = setup(t, { maxCostPerRun: 0.095 });
    assert.equal((await e.run(runArgs(...MINI))).code, 0);
  });

  test('with several providers connected an over-limit run submits to none of them', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const r = await e.run(runArgs(...BIG));
    assert.equal(r.code, 4);
    assert.equal(submitCalls(e.calls).length, 0);
  });
});

describe('unknown price', () => {
  // seedance-2.5-flash on wavespeed is offered but has no price entry in the fixture data, and
  // WaveSpeed's live price endpoint is down in these routes.
  test('exits 4 without --yes and submits nothing', async (t) => {
    const e = createEnvironment(t, { env: keysFor('wavespeed'), routes: routesFor({ wavespeed: {} }) });
    const r = await e.run(runArgs(...FLASH));
    assert.equal(r.code, 4);
    assert.equal(submitCalls(e.calls).length, 0);
    assert.equal(e.spendLines().length, 0);
  });

  test('--yes lets it start, and the spend log records that the estimate is unknown', async (t) => {
    const e = createEnvironment(t, { env: keysFor('wavespeed'), routes: routesFor({ wavespeed: {} }) });
    const r = await e.run(runArgs(...FLASH, '--yes'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(submitCalls(e.calls, 'wavespeed').length, 1);
    const submitted = e.spendLines().find((l) => l.event === 'submitted');
    assert.ok(submitted.estimateUsd === null || submitted.estimateUsd === undefined);
  });

  test('a known price on another connected provider wins and needs no confirmation', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'wavespeed'), routes: routesFor({ kie: {}, wavespeed: {} }) });
    const r = await e.run(runArgs(...FLASH));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'kie');
  });
});

describe('--dry-run', () => {
  test('prints provider, request body and estimate; makes no generation request', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const r = await e.run(runArgs(...MINI, '--duration', '5', '--dry-run'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'kie');
    approx(r.json.estimateUsd, 0.095);
    assert.equal(typeof r.json.request, 'object');
    assert.ok(leafValues(r.json.request).includes('480p'), 'the request body is shown');
    assert.equal(submitCalls(e.calls).length, 0);
    assert.equal(e.spendLines().length, 0, 'a dry run is not a spend');
  });

  test('works for every provider without contacting its generation endpoint', async (t) => {
    for (const id of ['kie', 'replicate', 'wavespeed', 'fal']) {
      const e = createEnvironment(t, { env: keysFor(id), routes: routesFor(id) });
      const r = await e.run(runArgs(...MINI, '--dry-run'));
      assert.equal(r.code, 0, `${id}: ${r.stderr}`);
      assert.equal(r.json.provider, id);
      assert.equal(submitCalls(e.calls).length, 0, id);
    }
  });

  test('a local --image is not uploaded during a dry run', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) }); // no upload route
    const img = path.join(e.cwd, 'first-frame.png');
    fs.writeFileSync(img, 'not-really-a-png');
    const r = await e.run(runArgs(...MINI, '--image', img, '--dry-run'));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(e.calls.filter((c) => c.method !== 'GET' && !/price|pricing/.test(c.url)).length, 0,
      'no POST/PUT of any kind (no upload, no generation)');
  });

  test('a dry run over the cost limit still reports the estimate (it spends nothing)', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(runArgs(...BIG, '--dry-run'));
    assert.equal(r.code, 0, r.stderr);
    approx(r.json.estimateUsd, 0.205 * 15);
  });

  test('--dry-run does not write the spend log or download anything', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    await e.run(runArgs(...MINI, '--dry-run', '--wait'));
    assert.equal(fs.existsSync(e.spendPath), false);
    assert.equal(fs.existsSync(path.join(e.cwd, 'cheapgen-out')), false);
  });
});

describe('explicit settings in every submit body', () => {
  const PROVIDERS = ['kie', 'replicate', 'wavespeed', 'fal'];

  for (const id of PROVIDERS) {
    test(`${id}: defaults (720p, 5 s, 16:9, audio on) are sent explicitly`, async (t) => {
      const e = createEnvironment(t, { env: keysFor(id), routes: routesFor(id) });
      const r = await e.run(runArgs('seedance-2.0-mini', '--yes'));
      assert.equal(r.code, 0, r.stderr);
      const values = leafValues(submitCalls(e.calls, id)[0].body);
      for (const expected of ['720p', '5', '16:9', 'true']) {
        assert.ok(values.includes(expected), `${id} body should contain explicit "${expected}", got ${JSON.stringify(values)}`);
      }
    });

    test(`${id}: user values (480p, 8 s, 9:16, no audio) are sent explicitly`, async (t) => {
      const e = createEnvironment(t, { env: keysFor(id), routes: routesFor(id) });
      const r = await e.run(runArgs('seedance-2.0-mini', '--res', '480p', '--duration', '8', '--aspect', '9:16', '--no-audio', '--yes'));
      assert.equal(r.code, 0, r.stderr);
      const values = leafValues(submitCalls(e.calls, id)[0].body);
      for (const expected of ['480p', '8', '9:16', 'false']) {
        assert.ok(values.includes(expected), `${id} body should contain "${expected}", got ${JSON.stringify(values)}`);
      }
      assert.ok(!values.includes('720p') && !values.includes('16:9'), 'defaults must not leak into an explicit request');
    });
  }

  test('--audio is sent as on explicitly even when the user passes the flag', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    await e.run(runArgs(...MINI, '--audio'));
    assert.ok(leafValues(submitCalls(e.calls, 'kie')[0].body).includes('true'));
  });

  test('images get an explicit aspect ratio too', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(runArgs('seedream-5-lite'));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(leafValues(submitCalls(e.calls, 'kie')[0].body).includes('16:9'));
  });

  test('the prompt reaches the provider', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    await e.run(runArgs(...MINI));
    assert.ok(leafValues(submitCalls(e.calls, 'kie')[0].body).includes('a calm lake at dawn'));
  });

  describe('auto duration', () => {
    const base = ['seedance-2.0-mini', '--res', '480p'];
    for (const form of [['--duration', 'auto'], ['--duration=auto'], ['--duration=-1']]) {
      test(`${form.join(' ')} is refused with code 2 and no network call`, async (t) => {
        const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
        const r = await e.run(runArgs(...base, ...form));
        assert.equal(r.code, 2);
        assert.equal(e.calls.length, 0);
        assert.equal(e.spendLines().length, 0);
      });
    }

    test('--allow-auto-duration lets it through; the estimate is the maximum possible cost', async (t) => {
      const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
      const r = await e.run(runArgs(...base, '--duration', 'auto', '--allow-auto-duration', '--dry-run'));
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      approx(r.json.estimateUsd, 0.019 * 15); // fixture maximum duration is 15 s
    });
  });

  describe('invalid requests fail with code 2 before any network call', () => {
    const bad = [
      ['unsupported resolution for the model', ['seedance-2.0-mini', '--res', '1080p']],
      ['duration above the model maximum', ['seedance-2.0-mini', '--duration', '99']],
      ['duration below the model minimum', ['seedance-2.0-mini', '--duration', '1']],
      ['unsupported aspect ratio', ['seedance-2.0-mini', '--aspect', '5:7']],
      ['unknown model', ['seedance-9']],
      ['missing prompt', null],
    ];
    for (const [name, args] of bad) {
      test(name, async (t) => {
        const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
        const argv = args ? ['run', ...args, '--prompt', 'x', '--json'] : ['run', 'seedance-2.0-mini', '--json'];
        const r = await e.run(argv);
        assert.equal(r.code, 2);
        assert.equal(e.calls.filter((c) => providerOfCall(c)).length, 0);
      });
    }
  });
});
