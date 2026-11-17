// Routing: with one key only that provider is contacted; the cheapest connected provider wins
// for the exact request; enabled:false; pin and --provider (no silent reroute); prefer, ties,
// --exclude; the balance check. Fixture prices: test/fixtures/data/prices.json.
// Run output shape assumed (--json): { provider, job, estimateUsd }.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, keysFor, runArgs, approx } from './helpers/harness.js';
import { routesFor, submitCalls, providerOfCall } from './helpers/providers.js';

const MINI = ['seedance-2.0-mini', '--res', '480p'];     // kie 0.095 < replicate 0.20 < wavespeed 0.27 < fal 0.3605
const V20 = ['seedance-2.0', '--res', '480p'];            // replicate 0.40 < kie 0.475 < wavespeed 0.54 < fal 0.70308
const FLASH = ['seedance-2.5-flash', '--res', '480p'];    // no replicate; wavespeed has no price entry
const IMAGE = ['seedream-5-lite'];                        // kie 0.0275; replicate = wavespeed = fal = 0.035

const providersSubmittedTo = (calls) => [...new Set(submitCalls(calls).map(providerOfCall))];

describe('exactly one key', () => {
  for (const id of ['kie', 'replicate', 'wavespeed', 'fal']) {
    test(`only ${id} connected: ${id} is used and no other host is contacted`, async (t) => {
      const e = createEnvironment(t, { env: keysFor(id), routes: routesFor(id) });
      const r = await e.run(runArgs(...MINI));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.provider, id);
      assert.ok(r.json.job.startsWith(`${id}:`), `job id carries its provider: ${r.json.job}`);
      assert.deepEqual(providersSubmittedTo(e.calls), [id]);
      const hosts = new Set(e.calls.map((c) => providerOfCall(c) ?? new URL(c.url).hostname));
      assert.deepEqual([...hosts], [id], 'every request goes to the one connected provider');
    });
  }
});

describe('cheapest connected provider for the exact request', () => {
  test('mini 480p: kie beats replicate, wavespeed and fal', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate', 'wavespeed', 'fal'),
      routes: routesFor({ kie: {}, replicate: {}, wavespeed: {}, fal: {} }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'kie');
    approx(r.json.estimateUsd, 0.095);
    assert.deepEqual(providersSubmittedTo(e.calls), ['kie']);
  });

  test('seedance-2.0 480p: replicate beats kie even though kie is cheaper for mini', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate', 'wavespeed'),
      routes: routesFor({ kie: {}, replicate: {}, wavespeed: {} }) });
    const r = await e.run(runArgs(...V20));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'replicate');
    approx(r.json.estimateUsd, 0.40);
    assert.deepEqual(providersSubmittedTo(e.calls), ['replicate']);
  });

  test('the estimate follows the requested duration and resolution', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const longer = await e.run(runArgs('seedance-2.0', '--res', '480p', '--duration', '8', '--dry-run'));
    assert.equal(longer.json.provider, 'replicate');
    approx(longer.json.estimateUsd, 0.08 * 8);
    const hd = await e.run(runArgs('seedance-2.0', '--res', '1080p', '--dry-run'));
    assert.equal(hd.json.provider, 'replicate');
    approx(hd.json.estimateUsd, 0.45 * 5);
  });

  test('image-to-video is routed too (first frame given as a URL)', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const r = await e.run(runArgs(...MINI, '--image', 'https://example.test/first.png'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'kie');
    assert.ok(JSON.stringify(submitCalls(e.calls, 'kie')[0].body).includes('https://example.test/first.png'));
  });

  test('image models are routed: seedream-5-lite goes to kie', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate', 'fal'), routes: routesFor({ kie: {}, replicate: {}, fal: {} }) });
    const r = await e.run(runArgs(...IMAGE));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'kie');
    approx(r.json.estimateUsd, 0.0275);
  });

  test('a provider that does not offer the model is skipped (flash is not on replicate)', async (t) => {
    const e = createEnvironment(t, { env: keysFor('replicate', 'fal'), routes: routesFor({ replicate: {}, fal: {} }) });
    const r = await e.run(runArgs(...FLASH));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'fal');
    assert.deepEqual(providersSubmittedTo(e.calls), ['fal']);
  });

  test('a provider whose price is unknown ranks after providers with a known price', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'wavespeed'), routes: routesFor({ kie: {}, wavespeed: {} }) });
    const r = await e.run(runArgs(...FLASH));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'kie');
  });
});

describe('ties, prefer, strategy, --exclude', () => {
  const connected = () => ({ env: keysFor('replicate', 'wavespeed', 'fal'), routes: routesFor({ replicate: {}, wavespeed: {}, fal: {} }) });

  test('a price tie with no prefer list is broken alphabetically (fal < replicate < wavespeed)', async (t) => {
    const e = createEnvironment(t, connected());
    const r = await e.run(runArgs(...IMAGE));
    assert.equal(r.json.provider, 'fal');
  });

  test('a price tie is broken by the prefer order first', async (t) => {
    const e = createEnvironment(t, { ...connected(), userConfig: { prefer: ['wavespeed', 'replicate'] } });
    assert.equal((await e.run(runArgs(...IMAGE))).json.provider, 'wavespeed');
  });

  test('prefer does not override a strictly lower price under strategy cheapest', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { strategy: 'cheapest', prefer: ['replicate'] } });
    assert.equal((await e.run(runArgs(...MINI))).json.provider, 'kie');
  });

  test('strategy "preferred" takes the first connected provider in prefer order', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { strategy: 'preferred', prefer: ['wavespeed', 'replicate', 'kie'] } });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'replicate', 'wavespeed is not connected, replicate is next in prefer');
  });

  test('strategy "preferred" skips a preferred provider that does not support the request', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { strategy: 'preferred', prefer: ['replicate', 'kie'] } });
    assert.equal((await e.run(runArgs(...FLASH))).json.provider, 'kie');
  });

  test('--exclude removes a provider for one run only', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const excluded = await e.run(runArgs(...MINI, '--exclude', 'kie'));
    assert.equal(excluded.json.provider, 'replicate');
    assert.equal(submitCalls(e.calls, 'kie').length, 0);
    const normal = await e.run(runArgs(...MINI));
    assert.equal(normal.json.provider, 'kie');
  });
});

describe('enabled:false', () => {
  test('a disabled provider is never chosen or called, even if cheapest and keyed', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ replicate: {} }), // no kie routes: any kie request fails the test
      userConfig: { providers: { kie: { enabled: false } } } });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'replicate');
    assert.ok(!e.calls.some((c) => providerOfCall(c) === 'kie'));
  });

  test('when the only keyed provider is disabled, run fails with code 3 and calls nothing', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), userConfig: { providers: { kie: { enabled: false } } } });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 3);
    assert.equal(e.calls.length, 0);
  });

  test('--provider cannot force a disabled provider', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ replicate: {} }),
      userConfig: { providers: { kie: { enabled: false } } } });
    const r = await e.run(runArgs(...MINI, '--provider', 'kie'));
    assert.equal(r.code, 3);
    assert.equal(e.calls.length, 0);
  });
});

describe('pin and --provider override cheapest and never silently reroute', () => {
  test('a per-model pin in config overrides cheapest', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { models: { 'seedance-2.0-mini': { provider: 'replicate' } } } });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'replicate');
    assert.equal(submitCalls(e.calls, 'kie').length, 0);
  });

  test('a pin applies only to its model', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { models: { 'seedance-2.0': { provider: 'kie' } } } });
    assert.equal((await e.run(runArgs(...V20))).json.provider, 'kie', 'pinned model goes to kie though replicate is cheaper');
    assert.equal((await e.run(runArgs(...MINI))).json.provider, 'kie');
    const image = await e.run(runArgs(...IMAGE));
    assert.equal(image.json.provider, 'kie');
  });

  test('--provider overrides both cheapest and a config pin', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate', 'wavespeed'),
      routes: routesFor({ kie: {}, replicate: {}, wavespeed: {} }),
      userConfig: { models: { 'seedance-2.0-mini': { provider: 'replicate' } } } });
    const r = await e.run(runArgs(...MINI, '--provider', 'wavespeed'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'wavespeed');
    assert.deepEqual(providersSubmittedTo(e.calls), ['wavespeed']);
  });

  test('--provider for a provider that does not offer the model fails; nothing is submitted', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const r = await e.run(runArgs(...FLASH, '--provider', 'replicate'));
    assert.equal(r.code, 3);
    assert.equal(submitCalls(e.calls).length, 0, 'must not fall back to kie');
    assert.equal(e.spendLines().length, 0);
  });

  test('a config pin to a provider that does not offer the model fails too', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { models: { 'seedance-2.5-flash': { provider: 'replicate' } } } });
    const r = await e.run(runArgs(...FLASH));
    assert.equal(r.code, 3);
    assert.equal(submitCalls(e.calls).length, 0);
  });

  test('a pin to a provider without a key fails and contacts nobody', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(runArgs(...MINI, '--provider', 'fal'));
    assert.equal(r.code, 3);
    assert.equal(submitCalls(e.calls).length, 0);
  });

  test('a pinned provider that rejects the job is not replaced by another provider', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: {}, replicate: { submit: 'rate-limited' } }) });
    const r = await e.run(runArgs(...MINI, '--provider', 'replicate'));
    assert.equal(r.code, 3);
    assert.equal(submitCalls(e.calls, 'kie').length, 0);
    assert.equal(submitCalls(e.calls, 'replicate').length, 1);
  });
});

describe('balance check', () => {
  test('a provider whose balance cannot cover the estimate is skipped', async (t) => {
    // kie reports 10 credits (about $0.05); the run needs $0.095
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: { balance: 'low' }, replicate: {} }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'replicate');
    assert.equal(submitCalls(e.calls, 'kie').length, 0);
  });

  test('wavespeed with a $0.01 balance is skipped for a $0.27 request', async (t) => {
    const e = createEnvironment(t, { env: keysFor('wavespeed', 'fal'),
      routes: routesFor({ wavespeed: { balance: 'low' }, fal: {} }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.json.provider, 'fal');
  });

  test('an unknown balance (fal key without billing permission) does not block the provider', async (t) => {
    const e = createEnvironment(t, { env: keysFor('fal'), routes: routesFor({ fal: { balance: 'forbidden' } }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'fal');
  });

  test('replicate has no balance endpoint and is treated as able to pay', async (t) => {
    const e = createEnvironment(t, { env: keysFor('replicate'), routes: routesFor({ replicate: {} }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!e.calls.some((c) => /account|balance|credit/i.test(c.url) && providerOfCall(c) === 'replicate'));
  });

  test('when no connected provider can pay, run fails with code 3', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'wavespeed'),
      routes: routesFor({ kie: { balance: 'low' }, wavespeed: { balance: 'low' } }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 3);
    assert.equal(submitCalls(e.calls).length, 0);
  });
});

describe('run never mentions unconnected providers', () => {
  test('output names only the connected provider', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const human = await e.run(['run', ...MINI, '--prompt', 'x']);
    const out = `${human.stdout}${human.stderr}`.toLowerCase();
    assert.equal(human.code, 0);
    assert.ok(!/not connected|wavespeed|replicate|\bfal\b/.test(out), out);
  });
});
