// Kie's public price list as the live price source.
// Uses test/fixtures/data-live/ (Kie entries carry live.kieDescription). Bundled Kie 480p is 0.019/s,
// so a 5 s quote is 0.095 from the bundled table; the lists below use different numbers to show where
// a price came from.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvironment, keysFor, quoteArgs, approx } from './helpers/harness.js';
import { routesFor } from './helpers/providers.js';
import { DESC, row, filler, kieRoutes, listCalls } from './helpers/kie-price-list.js';

const DATA_LIVE = fileURLToPath(new URL('./fixtures/data-live/', import.meta.url));
const MINI = ['seedance-2.0-mini', '--res', '480p', '--duration', '5'];
const kieQuote = (r) => r.json.quotes.find((q) => q.provider === 'kie');
const env = (t, rows, opts = {}, extra = {}) =>
  createEnvironment(t, { dataDir: DATA_LIVE, env: keysFor('kie'), routes: kieRoutes(rows, opts), ...extra });
const cachePath = (e) => path.join(e.home, '.cheapgen', 'cache', 'kie-price-list.json');

describe('quote with a Kie key uses the public price list', () => {
  test('reads pages of 100 until data.current >= data.pages, matches the row, reports source "live"', async (t) => {
    // 250 other rows first, so the wanted row is on page 3.
    const rows = [...filler(250), row(DESC.mini480, { usd: 0.021 })];
    const e = env(t, rows);
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    const q = kieQuote(r);
    assert.equal(q.source, 'live');
    approx(q.usd, 0.105);                       // 0.021 x 5 s
    assert.equal(q.verifiedOn, '2026-11-21');

    const calls = listCalls(e.calls);
    assert.equal(calls.length, 3, '251 rows at 100 per page is 3 pages');
    assert.deepEqual(calls.map((c) => c.body.pageNum), [1, 2, 3]);
    for (const c of calls) {
      assert.equal(c.body.pageSize, 100);
      assert.equal(c.body.modelDescription, '');
      assert.equal(c.body.interfaceType, '');
    }
  });

  test('stops at the last page: a single-page list is one request', async (t) => {
    const e = env(t, [row(DESC.mini480, { usd: 0.021 })]);
    await e.run(quoteArgs(...MINI));
    assert.equal(listCalls(e.calls).length, 1);
  });

  test('matches the description exactly, not by prefix or substring', async (t) => {
    const rows = [
      row(`${DESC.mini480} extra`, { usd: 0.5 }),
      row('bytedance/seedance-2-mini, 480P with video', { usd: 0.6 }),
      row(DESC.mini480.toUpperCase(), { usd: 0.7 }),
      row(DESC.mini480, { usd: 0.022 }),
    ];
    const r = await env(t, rows).run(quoteArgs(...MINI));
    assert.equal(kieQuote(r).source, 'live');
    approx(kieQuote(r).usd, 0.11);
  });

  test('prices a per-image entry from a "per image" row', async (t) => {
    const e = env(t, [row(DESC.pro1k, { usd: 0.04, unit: 'per image' })]);
    const r = await e.run(quoteArgs('seedream-5-pro', '--size', '1K'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(kieQuote(r).source, 'live');
    approx(kieQuote(r).usd, 0.04);
  });

  test('without usdPrice, creditPrice x 0.005 is used', async (t) => {
    const e = env(t, [row(DESC.mini480, { usd: null, credit: 4.4 })]);   // 4.4 credits = $0.022/s
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(kieQuote(r).source, 'live');
    approx(kieQuote(r).usd, 0.11);
  });

  test('other providers are still priced from the bundled table', async (t) => {
    const r = await env(t, [row(DESC.mini480, { usd: 0.021 })]).run(quoteArgs(...MINI));
    for (const q of r.json.quotes.filter((x) => x.provider !== 'kie')) assert.equal(q.source, 'bundled', q.provider);
    assert.deepEqual(r.json.quotes.map((q) => q.provider), ['kie', 'replicate', 'wavespeed', 'fal']);
    approx(r.json.quotes[0].usd, 0.105);
  });
});

describe('falling back to the bundled price', () => {
  test('a missing row falls back to bundled', async (t) => {
    const r = await env(t, [row(DESC.mini720, { usd: 0.05 }), ...filler(5)]).run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(kieQuote(r).source, 'bundled');
    approx(kieQuote(r).usd, 0.095);
  });

  test('a creditUnit that does not match the pricing type (per image row for a perSecond entry) falls back', async (t) => {
    const r = await env(t, [row(DESC.mini480, { usd: 0.021, unit: 'per image' })]).run(quoteArgs(...MINI));
    assert.equal(kieQuote(r).source, 'bundled');
    approx(kieQuote(r).usd, 0.095);
  });

  test('a per second row for a perImage entry falls back too', async (t) => {
    const r = await env(t, [row(DESC.pro1k, { usd: 0.04, unit: 'per second' })]).run(quoteArgs('seedream-5-pro', '--size', '1K'));
    assert.equal(kieQuote(r).source, 'bundled');
    approx(kieQuote(r).usd, 0.035);
  });

  test('a failed page means the bundled price is used and nothing is cached', async (t) => {
    const rows = [...filler(150), row(DESC.mini480, { usd: 0.021 })];       // 2 pages
    const e = env(t, rows, { failPage: 2 });
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(kieQuote(r).source, 'bundled');
    approx(kieQuote(r).usd, 0.095);
    assert.ok(!fs.existsSync(cachePath(e)), 'a partial list must not be cached');
  });

  test('an unreachable list (network error) falls back to bundled', async (t) => {
    const e = createEnvironment(t, { dataDir: DATA_LIVE, env: keysFor('kie'),
      routes: kieRoutes({ error: new TypeError('fetch failed') }) });
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(kieQuote(r).source, 'bundled');
  });

  test('without a Kie key the list is never requested (bundled only)', async (t) => {
    const e = createEnvironment(t, { dataDir: DATA_LIVE, env: keysFor('replicate'), routes: routesFor('replicate') });
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(kieQuote(r).source, 'bundled');
    assert.equal(listCalls(e.calls).length, 0);
    assert.ok(!fs.existsSync(cachePath(e)));
  });

  test('a disabled Kie is not asked for live prices either', async (t) => {
    const e = env(t, [row(DESC.mini480, { usd: 0.021 })], {}, { userConfig: { providers: { kie: { enabled: false } } } });
    const r = await e.run(quoteArgs(...MINI));
    assert.equal(kieQuote(r).source, 'bundled');
    assert.equal(listCalls(e.calls).length, 0);
  });
});

describe('the list cache', () => {
  test('is written to <home>/.cheapgen/cache/kie-price-list.json and holds the rows', async (t) => {
    const e = env(t, [row(DESC.mini480, { usd: 0.021 })]);
    await e.run(quoteArgs(...MINI));
    assert.ok(fs.existsSync(cachePath(e)), 'cache file exists');
    const text = fs.readFileSync(cachePath(e), 'utf8');
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(text.includes(DESC.mini480), 'the cached list contains the rows');
    assert.ok(!text.includes('test-kie-key'), 'no key in the cache');
  });

  test('a second command within 24 hours makes no list request and uses the cached price', async (t) => {
    const e = env(t, [row(DESC.mini480, { usd: 0.021 })]);
    await e.run(quoteArgs(...MINI));
    assert.equal(listCalls(e.calls).length, 1);

    // The list now has a different price, which a refetch would show.
    e.setRoutes(kieRoutes([row(DESC.mini480, { usd: 0.03 })]));
    e.setNow('2026-11-22T11:00:00Z');                                       // 23 hours later
    const again = await e.run(quoteArgs(...MINI));
    assert.equal(listCalls(e.calls).length, 1, 'still one list request in total');
    approx(kieQuote(again).usd, 0.105);
    assert.notEqual(kieQuote(again).source, 'bundled');
  });

  test('a cached list also serves a different request in a later command', async (t) => {
    const e = env(t, [row(DESC.mini480, { usd: 0.021 }), row(DESC.mini720, { usd: 0.05 })]);
    await e.run(quoteArgs(...MINI));
    const r = await e.run(quoteArgs('seedance-2.0-mini', '--res', '720p', '--duration', '5'));
    assert.equal(listCalls(e.calls).length, 1);
    approx(kieQuote(r).usd, 0.25);
  });

  test('after 24 hours the list is fetched again', async (t) => {
    const e = env(t, [row(DESC.mini480, { usd: 0.021 })]);
    await e.run(quoteArgs(...MINI));

    e.setRoutes(kieRoutes([row(DESC.mini480, { usd: 0.03 })]));
    e.setNow('2026-11-22T13:00:00Z');                                       // 25 hours later
    const later = await e.run(quoteArgs(...MINI));
    assert.equal(listCalls(e.calls).length, 2);
    assert.equal(kieQuote(later).source, 'live');
    approx(kieQuote(later).usd, 0.15);
  });

  test('the list is requested at most once per command, even when many Kie entries are priced', async (t) => {
    // `prices --check` prices every Kie entry of the catalog (3 of them) in one command.
    const e = env(t, [row(DESC.mini480, { usd: 0.019 }), row(DESC.mini720, { usd: 0.041 }),
      row(DESC.pro1k, { usd: 0.035, unit: 'per image' }), ...filler(120)]);
    const r = await e.run(['prices', '--check', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(listCalls(e.calls).length, 2, '123 rows is 2 pages, fetched once');
    assert.deepEqual(listCalls(e.calls).map((c) => c.body.pageNum), [1, 2]);
  });
});
