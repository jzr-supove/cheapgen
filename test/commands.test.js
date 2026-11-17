// Read-only commands: `models` and `providers`.
// Assumed shape: providers --json -> { providers: [{ id, connected, enabled, balance }] }, balance in USD or null.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, keysFor, approx } from './helpers/harness.js';
import { routesFor } from './helpers/providers.js';

describe('models', () => {
  test('lists the canonical models without keys or network', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['models']);
    assert.equal(r.code, 0, r.stderr);
    for (const id of ['seedance-2.0-mini', 'seedance-2.0', 'seedance-2.5', 'seedance-2.5-flash', 'seedream-5-lite']) {
      assert.ok(r.stdout.includes(id), `${id} should be listed`);
    }
    assert.equal(r.calls.length, 0);
  });

  test('--search filters by text', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['models', '--search', 'flash']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('seedance-2.5-flash'));
    assert.ok(!r.stdout.includes('seedance-2.0-mini'));
    assert.ok(!r.stdout.includes('seedream-5-lite'));
  });
});

describe('providers', () => {
  test('reports connected, enabled and balance (kie credits converted to USD at $0.005 each)', async (t) => {
    const e = createEnvironment(t, {
      env: keysFor('kie', 'replicate', 'wavespeed'),
      routes: routesFor({ kie: {}, wavespeed: {} }),
      userConfig: { providers: { wavespeed: { enabled: false } } },
    });
    const r = await e.run(['providers', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const by = Object.fromEntries(r.json.providers.map((p) => [p.id, p]));
    assert.deepEqual([by.kie.connected, by.kie.enabled], [true, true]);
    approx(by.kie.balance, 100);                       // 20000 credits
    assert.equal(by.replicate.connected, true);
    assert.equal(by.replicate.balance, null, 'replicate has no balance endpoint');
    assert.deepEqual([by.wavespeed.connected, by.wavespeed.enabled], [true, false]);
    assert.equal(by.fal.connected, false);
    assert.ok(!e.calls.some((c) => c.url.includes('fal.ai')), 'unconnected fal is not contacted');
    assert.ok(!e.calls.some((c) => c.url.includes('wavespeed')), 'disabled wavespeed is not contacted');
  });

  test('an unreadable fal balance (no billing permission) is reported as unknown, not as an error', async (t) => {
    const e = createEnvironment(t, { env: keysFor('fal'), routes: routesFor({ fal: { balance: 'forbidden' } }) });
    const r = await e.run(['providers', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.providers.find((p) => p.id === 'fal').balance, null);
  });
});
