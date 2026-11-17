// quote: list, order, chosen provider, unconnected labels, showUnconnected; price source
// (live/cache/bundled), verification date and stale-data warning; per-token quotes use exact
// frame sizes; an auto duration is quoted at the maximum cost.
// Assumed `quote --json` shape:
//   { model, mode, quotes: [{ provider, usd|null, source, verifiedOn, connected, chosen }], warnings: [string] }
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, keysFor, quoteArgs, approx } from './helpers/harness.js';
import { routesFor, fixture } from './helpers/providers.js';

const MINI = ['seedance-2.0-mini', '--res', '480p', '--duration', '5'];
const byProvider = (r) => Object.fromEntries(r.json.quotes.map((q) => [q.provider, q]));

describe('quote', () => {
  test('lists every supporting provider sorted by price and marks the one run would use', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.quotes.map((q) => q.provider), ['kie', 'replicate', 'wavespeed', 'fal']);
    const prices = r.json.quotes.map((q) => q.usd);
    approx(prices[0], 0.095); approx(prices[1], 0.20); approx(prices[2], 0.27); approx(prices[3], 0.3605);
    assert.deepEqual(r.json.quotes.map((q) => q.chosen), [true, false, false, false]);
    assert.deepEqual(r.json.quotes.map((q) => q.connected), [true, true, false, false]);
  });

  test('providers that do not offer the model are not listed (flash is not on replicate)', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie') , routes: routesFor({ kie: {} }) });
    const r = await e.run(quoteArgs('seedance-2.5-flash', '--res', '480p'));
    assert.ok(!r.json.quotes.some((q) => q.provider === 'replicate'));
    assert.ok(r.json.quotes.some((q) => q.provider === 'kie'));
  });

  test('the chosen provider is the cheapest CONNECTED one, even when an unconnected one is cheaper', async (t) => {
    const e = createEnvironment(t, { env: keysFor('replicate', 'wavespeed'), routes: routesFor({ replicate: {}, wavespeed: {} }) });
    const r = await e.run(quoteArgs(...MINI));
    const q = byProvider(r);
    assert.equal(r.json.quotes[0].provider, 'kie', 'kie is cheapest overall and listed first');
    assert.equal(q.kie.connected, false);
    assert.equal(q.kie.chosen, false);
    assert.equal(q.replicate.chosen, true);
  });

  test('a disabled provider is never marked as the choice', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { providers: { kie: { enabled: false } } } });
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.quotes.find((q) => q.chosen)?.provider, 'replicate');
  });

  test('a provider whose price is unknown is listed with usd null, after priced providers', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'wavespeed'), routes: routesFor({ kie: {}, wavespeed: {} }) });
    const r = await e.run(quoteArgs('seedance-2.5-flash', '--res', '480p'));
    const q = byProvider(r);
    assert.equal(q.wavespeed.usd, null);
    assert.equal(r.json.quotes.at(-1).provider, 'wavespeed');
    assert.equal(q.kie.chosen, true);
  });

  test('human output marks unconnected providers with "(not connected)" when showUnconnected is true', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(['quote', ...MINI]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const line = (name) => lines.find((l) => l.toLowerCase().includes(name));
    assert.match(line('wavespeed'), /\(not connected\)/);
    assert.match(line('fal'), /\(not connected\)/);
    assert.match(line('replicate'), /\(not connected\)/);
    assert.doesNotMatch(line('kie'), /\(not connected\)/);
  });

  test('showUnconnected:false hides unconnected providers in both outputs', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }),
      userConfig: { showUnconnected: false } });
    const json = await e.run(quoteArgs(...MINI));
    assert.deepEqual(json.json.quotes.map((q) => q.provider), ['kie', 'replicate']);
    const human = await e.run(['quote', ...MINI]);
    assert.doesNotMatch(human.stdout, /not connected/i);
    assert.doesNotMatch(human.stdout.toLowerCase(), /wavespeed|\bfal\b/);
  });

  test('with no keys quote still works, lists all providers as unconnected and contacts nobody', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.quotes.length, 4);
    assert.ok(r.json.quotes.every((q) => q.connected === false && q.chosen === false));
    assert.equal(r.calls.length, 0);
  });

  test('a bad request is refused with code 2 before any network call', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie') });
    const r = await e.run(quoteArgs('seedance-2.0-mini', '--res', '1080p')); // mini tops out at 720p
    assert.equal(r.code, 2);
    assert.equal(e.calls.length, 0);
    assert.equal((await e.run(quoteArgs('no-such-model'))).code, 2);
  });
});

describe('price source, verification date, staleness', () => {
  test('bundled prices carry source "bundled" and the entry verifiedOn date', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
    const q = byProvider(await e.run(quoteArgs(...MINI)));
    assert.equal(q.kie.source, 'bundled');
    assert.equal(q.kie.verifiedOn, '2026-11-18');
    assert.equal(q.replicate.verifiedOn, '2026-11-10');
    assert.equal(q.wavespeed.source, 'bundled', 'unconnected providers are priced from bundled data');
  });

  test('human output shows the source and verification date', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(['quote', ...MINI]);
    assert.match(r.stdout, /bundled/i);
    assert.match(r.stdout, /2026-11-18/);
  });

  test('a live price from the provider is labeled "live" and dated today', async (t) => {
    const e = createEnvironment(t, { env: keysFor('wavespeed'),
      routes: routesFor({ wavespeed: { live: { status: 200, json: fixture('wavespeed', 'price-live') } } }) });
    const q = byProvider(await e.run(quoteArgs(...MINI)));
    assert.equal(q.wavespeed.source, 'live');
    approx(q.wavespeed.usd, 0.25);
    assert.equal(q.wavespeed.verifiedOn, '2026-11-21');
  });

  test('a live price is reused from cache for 24 hours, then bundled data takes over', async (t) => {
    const e = createEnvironment(t, { env: keysFor('wavespeed'),
      routes: routesFor({ wavespeed: { live: { status: 200, json: fixture('wavespeed', 'price-live') } } }) });
    assert.equal(byProvider(await e.run(quoteArgs(...MINI))).wavespeed.source, 'live');

    e.setRoutes(routesFor({ wavespeed: {} })); // live lookup now fails (503)
    e.setNow('2026-11-21T20:00:00Z');          // 8 hours later
    const cached = byProvider(await e.run(quoteArgs(...MINI))).wavespeed;
    assert.equal(cached.source, 'cache');
    approx(cached.usd, 0.25);

    e.setNow('2026-11-22T13:00:00Z');          // 25 hours later
    const later = byProvider(await e.run(quoteArgs(...MINI))).wavespeed;
    assert.equal(later.source, 'bundled');
    approx(later.usd, 0.27);
  });

  test('bundled data 14 days old gives no warning; 15 days old does', async (t) => {
    // oldest shown entry is replicate/wavespeed/fal, verifiedOn 2026-11-10
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }), now: '2026-11-24T00:00:00Z' });
    const fresh = await e.run(quoteArgs(...MINI));
    assert.deepEqual(fresh.json.warnings ?? [], [], 'exactly 14 days is not "more than 14 days"');

    e.setNow('2026-11-25T00:00:00Z');
    const stale = await e.run(quoteArgs(...MINI));
    assert.ok(stale.json.warnings.length > 0, 'expected a stale-price warning');
    assert.match(stale.json.warnings.join(' '), /2026-11-10|bundled|stale|old|days/i);
  });

  test('the stale warning also reaches the human output', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }), now: '2026-12-31T00:00:00Z' });
    const r = await e.run(['quote', ...MINI]);
    assert.match(`${r.stdout}${r.stderr}`, /warn|stale|old|days/i);
  });

  test('a real run also records and reports where its price came from', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const r = await e.run(['run', ...MINI, '--prompt', 'x', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(e.spendLines()[0].priceSource, 'bundled');
  });
});

describe('exact frame sizes and auto duration through quote', () => {
  const cases = [
    // [model, extra args, expected fal USD for 5 s]
    ['seedance-2.0', ['--res', '480p', '--aspect', '16:9'], 0.70308],   // 864x496
    ['seedance-2.5', ['--res', '480p', '--aspect', '16:9'], 0.672525],  // 854x480
    ['seedance-2.0', ['--res', '720p', '--aspect', '16:9'], 1.512],     // 1280x720
    ['seedance-2.0', ['--res', '480p', '--aspect', '1:1'], 0.672],      // 640x640
  ];
  for (const [model, extra, expected] of cases) {
    test(`fal ${model} ${extra.join(' ')} is $${expected}`, async (t) => {
      const e = createEnvironment(t);
      const r = await e.run(quoteArgs(model, ...extra, '--duration', '5'));
      assert.equal(r.code, 0, r.stderr);
      approx(byProvider(r).fal.usd, expected, 1e-6);
    });
  }

  test('--duration auto is refused with code 2 unless --allow-auto-duration, then quotes the maximum', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    const refused = await e.run(quoteArgs('seedance-2.0-mini', '--res', '720p', '--duration', 'auto'));
    assert.equal(refused.code, 2);
    assert.equal(e.calls.length, 0);
    const allowed = await e.run(quoteArgs('seedance-2.0-mini', '--res', '720p', '--duration', 'auto', '--allow-auto-duration'));
    assert.equal(allowed.code, 0, allowed.stderr);
    approx(byProvider(allowed).kie.usd, 0.041 * 15); // the model's maximum duration is 15 s
  });
});
