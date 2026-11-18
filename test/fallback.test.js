// Fallback: a clear rejection moves to the next cheapest provider; an unknown outcome never
// falls back (exit 5); a job that fails after acceptance is not retried unless retryFailedJobs
// is on and the failure was on the provider's side. Fallback never goes above the cost limit.
// Exit codes: 3 no usable provider, 4 needs confirmation, 5 unknown outcome, 6 job failed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, keysFor, runArgs } from './helpers/harness.js';
import { routesFor, submitCalls, providerOfCall } from './helpers/providers.js';

const MINI = ['seedance-2.0-mini', '--res', '480p'];   // kie .095, replicate .20, wavespeed .27, fal .3605
const V20 = ['seedance-2.0', '--res', '480p'];          // replicate .40, kie .475, wavespeed .54
const count = (calls, id) => submitCalls(calls, id).length;

describe('clear rejection falls back to the next-cheapest connected provider', () => {
  const cases = [
    { name: 'Kie out of credits (envelope code 402)', model: MINI, first: 'kie', second: 'replicate', outcome: 'insufficient' },
    { name: 'Kie out of credits (HTTP 402)', model: MINI, first: 'kie', second: 'replicate', outcome: 'insufficient-http' },
    { name: 'Kie bad key (HTTP 401)', model: MINI, first: 'kie', second: 'replicate', outcome: 'unauthorized' },
    { name: 'Kie bad key (envelope code 401)', model: MINI, first: 'kie', second: 'replicate', outcome: 'unauthorized-envelope' },
    { name: 'Kie rate limited (429)', model: MINI, first: 'kie', second: 'replicate', outcome: 'rate-limited' },
    { name: 'WaveSpeed 1407 insufficient credits (HTTP 400)', model: MINI, first: 'wavespeed', second: 'fal', outcome: 'insufficient' },
    { name: 'WaveSpeed 1407 insufficient credits (HTTP 200 envelope)', model: MINI, first: 'wavespeed', second: 'fal', outcome: 'insufficient-envelope' },
    { name: 'WaveSpeed rate limited (429)', model: MINI, first: 'wavespeed', second: 'fal', outcome: 'rate-limited' },
    { name: 'Replicate rate limited (429)', model: V20, first: 'replicate', second: 'kie', outcome: 'rate-limited' },
    { name: 'Replicate out of credit (402)', model: V20, first: 'replicate', second: 'kie', outcome: 'insufficient' },
    { name: 'Replicate bad token (401)', model: V20, first: 'replicate', second: 'kie', outcome: 'unauthorized' },
  ];
  for (const c of cases) {
    test(c.name, async (t) => {
      const e = createEnvironment(t, { env: keysFor(c.first, c.second),
        routes: routesFor({ [c.first]: { submit: c.outcome }, [c.second]: {} }) });
      const r = await e.run(runArgs(...c.model));
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(r.json.provider, c.second);
      assert.equal(count(e.calls, c.first), 1, 'the rejecting provider is tried exactly once');
      assert.equal(count(e.calls, c.second), 1);
      const order = submitCalls(e.calls).map(providerOfCall);
      assert.equal(order[0], c.first, 'cheapest is tried first');
      assert.match(r.stderr, new RegExp(c.first, 'i'), 'the fallback is announced on stderr');
      const logged = e.spendLines().filter((l) => l.event === 'submitted');
      assert.equal(logged.length, 1, 'only the accepted job is logged');
      assert.ok(logged[0].job.startsWith(`${c.second}:`));
    });
  }

  test('fal exhausted balance (403) falls back to the next provider', async (t) => {
    // pin the order with strategy "preferred" so fal is tried first
    const e = createEnvironment(t, { env: keysFor('fal', 'kie'),
      routes: routesFor({ fal: { submit: 'insufficient', balance: 'forbidden' }, kie: {} }),
      userConfig: { strategy: 'preferred', prefer: ['fal', 'kie'] } });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'kie');
    assert.equal(count(e.calls, 'fal'), 1);
  });

  test('falls through several rejections in price order', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate', 'wavespeed'),
      routes: routesFor({ kie: { submit: 'insufficient' }, replicate: { submit: 'rate-limited' }, wavespeed: {} }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.provider, 'wavespeed');
  });

  test('when every provider rejects, run fails with code 3 and logs no job', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: { submit: 'insufficient' }, replicate: { submit: 'insufficient' } }) });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 3);
    assert.equal(count(e.calls, 'kie'), 1);
    assert.equal(count(e.calls, 'replicate'), 1);
    assert.equal(e.spendLines().length, 0);
  });

  test('fallback never goes above the cost limit', async (t) => {
    // mini 720p: kie 0.205 (within the 0.30 limit); replicate 0.45 would exceed it
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: { submit: 'insufficient' }, replicate: {} }),
      userConfig: { maxCostPerRun: 0.30 } });
    const r = await e.run(runArgs('seedance-2.0-mini', '--res', '720p'));
    assert.ok([3, 4].includes(r.code), `expected 3 or 4, got ${r.code}`);
    assert.equal(count(e.calls, 'replicate'), 0, 'the over-limit fallback must not be submitted');
    assert.equal(e.spendLines().length, 0);
  });
});

describe('unknown outcome never falls back (exit code 5)', () => {
  const cases = [
    { name: 'Kie network error', model: MINI, first: 'kie', second: 'replicate', outcome: 'network-error' },
    { name: 'Kie client timeout', model: MINI, first: 'kie', second: 'replicate', outcome: 'timeout' },
    { name: 'Kie HTTP 500 without a task id', model: MINI, first: 'kie', second: 'replicate', outcome: 'server-error' },
    { name: 'Kie HTTP 502 with an HTML/text body', model: MINI, first: 'kie', second: 'replicate', outcome: 'bad-gateway' },
    { name: 'WaveSpeed network error', model: MINI, first: 'wavespeed', second: 'fal', outcome: 'network-error' },
    { name: 'WaveSpeed HTTP 500 without a task id', model: MINI, first: 'wavespeed', second: 'fal', outcome: 'server-error' },
    { name: 'WaveSpeed timeout', model: MINI, first: 'wavespeed', second: 'fal', outcome: 'timeout' },
    { name: 'Replicate HTTP 500', model: V20, first: 'replicate', second: 'kie', outcome: 'server-error' },
    { name: 'Replicate timeout', model: V20, first: 'replicate', second: 'kie', outcome: 'timeout' },
  ];
  for (const c of cases) {
    test(c.name, async (t) => {
      const e = createEnvironment(t, { env: keysFor(c.first, c.second),
        routes: routesFor({ [c.first]: { submit: c.outcome }, [c.second]: {} }) });
      const r = await e.run(runArgs(...c.model));
      assert.equal(r.code, 5, `${r.stdout}\n${r.stderr}`);
      assert.equal(count(e.calls, c.first), 1, 'the POST is not retried');
      assert.equal(count(e.calls, c.second), 0, 'no second submit anywhere');
      assert.equal(r.error?.provider, c.first);
      assert.ok(typeof r.error?.message === 'string' && r.error.message.length > 0);
      assert.equal(e.spendLines().filter((l) => l.event === 'submitted').length, 0,
        'nothing was accepted, so no submitted line');
    });
  }
});

describe('a job that fails after acceptance', () => {
  test('is not retried elsewhere by default (exit 6, one submit, finished line says failed)', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: { states: ['generating', 'fail'] }, replicate: {} }) });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 6, `${r.stdout}\n${r.stderr}`);
    assert.equal(count(e.calls, 'kie'), 1);
    assert.equal(count(e.calls, 'replicate'), 0);
    const lines = e.spendLines();
    assert.deepEqual(lines.map((l) => l.event), ['submitted', 'finished']);
    assert.equal(lines[1].state, 'failed');
  });

  test('with retryFailedJobs a provider-side failure on a provider that does not charge is retried on the next candidate', async (t) => {
    // Assumption: Kie failCode 500 is a provider fault; failed Kie tasks are never charged.
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: { states: ['fail-provider-fault'] }, replicate: {} }),
      userConfig: { retryFailedJobs: true } });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(count(e.calls, 'kie'), 1);
    assert.equal(count(e.calls, 'replicate'), 1);
  });

  test('with retryFailedJobs a failure that is the request\'s fault (content policy) is still not retried', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: { states: ['fail'] }, replicate: {} }),
      userConfig: { retryFailedJobs: true } });
    const r = await e.run(runArgs(...MINI, '--wait'));
    assert.equal(r.code, 6);
    assert.equal(count(e.calls, 'replicate'), 0);
  });

  test('a retry never exceeds the cost limit', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'),
      routes: routesFor({ kie: { states: ['fail-provider-fault'] }, replicate: {} }),
      userConfig: { retryFailedJobs: true, maxCostPerRun: 0.30 } });
    const r = await e.run(runArgs('seedance-2.0-mini', '--res', '720p', '--wait')); // kie 0.205, replicate 0.45
    assert.notEqual(r.code, 0);
    assert.equal(count(e.calls, 'replicate'), 0);
  });
});
