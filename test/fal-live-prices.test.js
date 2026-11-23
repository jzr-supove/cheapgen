// fal's pricing API gives one base unit price per endpoint, so entries billed at a higher
// rate (bigger sizes, higher resolutions) opt out with `live: { falUnitPrice: false }`.
// It also allows only about two requests a minute, so `prices --check` asks once for all endpoints.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, DEFAULT_DATA_DIR } from '../src/catalog.js';
import { ADAPTERS } from '../src/providers/index.js';
import { buildCanonicalRequest } from '../src/request.js';
import { bundledPrice } from '../src/pricing/index.js';
import { createEnvironment, keysFor, approx } from './helpers/harness.js';
import { createFakeFetch } from './helpers/fake-fetch.js';
import { LIST_URL } from './helpers/kie-price-list.js';

const PRICING_URL = /^https:\/\/api\.fal\.ai\/v1\/models\/pricing/;
const NOW = new Date('2026-11-23T12:00:00Z');
const catalog = loadCatalog(DEFAULT_DATA_DIR);
const unitOf = (p) => (p.type === 'perImage' ? p.usd : p.usdPer1kTokens);
const endpointsOf = (url) => new URL(url).searchParams.getAll('endpoint_id');
const pricingCalls = (calls) => calls.filter((c) => PRICING_URL.test(c.url));

const price = (endpoint_id, unit_price, unit, currency = 'USD') => ({ endpoint_id, unit_price, unit, currency });

/** A fal pricing route that answers for every requested endpoint found in `table` (endpoint -> price object). */
const falRoute = (table, { reverse = false } = {}) => ({
  method: 'GET', url: PRICING_URL,
  responses: [(req) => {
    const prices = endpointsOf(req.url).filter((e) => table[e]).map((e) => table[e]);
    if (reverse) prices.reverse();
    return { status: 200, json: { prices, next_cursor: null, has_more: false } };
  }],
});

describe('fal live price opt-out', () => {
  const request = (model, flags) =>
    buildCanonicalRequest(model, { prompt: 'x', ...flags }, catalog, { cwd: os.tmpdir(), requirePrompt: false });
  const ctxWith = (routes) => {
    const fake = createFakeFetch(routes);
    return { fake, ctx: { fetch: fake.fetch, key: 'k:s', sleep: async () => {}, now: () => NOW } };
  };
  const NANO = 'fal-ai/nano-banana-pro';

  test('an entry flagged falUnitPrice:false gets no live price and no request', async () => {
    const r = request('nano-banana-pro', { size: '4K', aspect: '1:1' });
    const entry = catalog.models['nano-banana-pro'].providers.fal;
    const bundled = bundledPrice(catalog, 'fal', r, NOW);
    const flagged = { ...bundled, entry: { ...bundled.entry, live: { falUnitPrice: false } } };
    const { fake, ctx } = ctxWith([falRoute({ [NANO]: price(NANO, 0.15, 'images') })]);
    const live = await ADAPTERS.fal.livePrice(r, ctx, { entry, bundled: flagged, frameSizes: catalog.frameSizes });
    assert.equal(live, null);
    assert.equal(fake.calls.length, 0);
  });

  test('an unflagged entry still gets fal\'s live price', async () => {
    const r = request('nano-banana-pro', { size: '1K', aspect: '1:1' });
    const entry = catalog.models['nano-banana-pro'].providers.fal;
    const bundled = bundledPrice(catalog, 'fal', r, NOW);
    const clean = { ...bundled, entry: { ...bundled.entry, live: undefined } };
    const { fake, ctx } = ctxWith([falRoute({ [NANO]: price(NANO, 0.16, 'images') })]);
    const live = await ADAPTERS.fal.livePrice(r, ctx, { entry, bundled: clean, frameSizes: catalog.frameSizes });
    approx(live.usd, 0.16);
    assert.equal(pricingCalls(fake.calls).length, 1);
  });
});

describe('quote on the real catalog with a fal key', () => {
  const kieDown = { method: 'POST', url: LIST_URL, status: 503, json: {} };
  const billing = { method: 'GET', url: /^https:\/\/api\.fal\.ai\/v1\/account\/billing/, status: 403, json: {} };
  const make = (t, table) =>
    createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('fal'), routes: [kieDown, billing, falRoute(table)] });
  const falQuote = (r) => r.json.quotes.find((q) => q.provider === 'fal');

  test('nano-banana-pro: 4K keeps the bundled $0.30, 1K uses fal\'s live price', async (t) => {
    const e = make(t, { 'fal-ai/nano-banana-pro': price('fal-ai/nano-banana-pro', 0.16, 'images') });
    const big = await e.run(['quote', 'nano-banana-pro', '--size', '4K', '--aspect', '1:1', '--json']);
    assert.equal(big.code, 0, big.stderr);
    assert.equal(falQuote(big).source, 'bundled');
    approx(falQuote(big).usd, 0.30);
    const small = await e.run(['quote', 'nano-banana-pro', '--size', '1K', '--aspect', '1:1', '--json']);
    assert.equal(falQuote(small).source, 'live');
    approx(falQuote(small).usd, 0.16);
  });

  test('seedance-2.5: 1080p keeps its bundled price, 720p uses a live one', async (t) => {
    const endpoint = 'bytedance/seedance-2.5/text-to-video';
    const offline = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, routes: [kieDown] });
    const expected = falQuote(await offline.run(['quote', 'seedance-2.5', '--res', '1080p', '--json']));
    assert.equal(expected.source, 'bundled');

    const e = make(t, { [endpoint]: price(endpoint, 0.03, '1000 tokens') });
    const hi = await e.run(['quote', 'seedance-2.5', '--res', '1080p', '--json']);
    assert.equal(falQuote(hi).source, 'bundled');
    approx(falQuote(hi).usd, expected.usd);
    const lo = await e.run(['quote', 'seedance-2.5', '--res', '720p', '--json']);
    assert.equal(falQuote(lo).source, 'live');
  });
});

describe('prices.json: fal prices that differ from a model\'s base price opt out of the live unit price', () => {
  // fal's pricing API gives one price per endpoint: the rate most of the model's sizes share, or
  // the lowest when no rate is shared. A dearer size, or a 4k rate below it, keeps the bundled price.
  const baseOf = (units) => {
    const count = new Map();
    for (const u of units) count.set(u, (count.get(u) ?? 0) + 1);
    const most = Math.max(...count.values());
    return Math.min(...[...count].filter(([, n]) => n === most).map(([u]) => u));
  };

  test('exactly the entries whose unit price differs from the base are flagged', () => {
    const byModel = new Map();
    for (const e of catalog.prices.entries) {
      if (e.provider !== 'fal' || !['perImage', 'perToken'].includes(e.pricing.type)) continue;
      byModel.set(e.model, [...(byModel.get(e.model) ?? []), e]);
    }
    assert.ok(byModel.size > 0);
    let flagged = 0;
    for (const [model, entries] of byModel) {
      const base = baseOf(entries.map((e) => unitOf(e.pricing)));
      for (const e of entries) {
        const differs = unitOf(e.pricing) !== base;
        if (differs) flagged += 1;
        assert.equal(e.live?.falUnitPrice === false, differs,
          `${model} ${JSON.stringify(e.when)} at ${unitOf(e.pricing)} (base ${base})`);
      }
    }
    assert.ok(flagged >= 5, 'nano-banana-pro 4K, seedance-2.5 1080p, the dearer nano-banana-2.1 sizes, seedance 4k');
  });
});

describe('prices --check: one request for all fal endpoints', () => {
  const MINI = 'bytedance/seedance-2.0/mini/text-to-video';
  const FAST = 'bytedance/seedance-2.0/fast/text-to-video';
  const S25 = 'bytedance/seedance-2.5/text-to-video';
  const NANO = 'fal-ai/nano-banana-pro';
  const base = { provider: 'fal', mode: '*', sourceUrl: 'https://fal.ai/models/x', verifiedOn: '2026-11-20' };
  const tok = (model, res, usd, extra = {}) => ({ ...base, model, when: { resolution: res },
    pricing: { type: 'perToken', usdPer1kTokens: usd, fps: 24 }, ...extra });
  const img = (size, usd, extra = {}) => ({ ...base, model: 'nano-banana-pro', when: { size },
    pricing: { type: 'perImage', usd }, ...extra });
  const NO = { live: { falUnitPrice: false } };
  const ENTRIES = [tok('seedance-2.0-mini', '480p', 0.007), tok('seedance-2.0-mini', '720p', 0.007),
    tok('seedance-2.0-fast', '480p', 0.0112), tok('seedance-2.5', '720p', 0.0214),
    tok('seedance-2.5', '1080p', 0.0234, NO), img('1K', 0.15), img('4K', 0.30, NO)];

  /** Copies the real data files, with prices.json replaced by `entries`. */
  function dataDir(t, entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapgen-data-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const f of fs.readdirSync(DEFAULT_DATA_DIR)) fs.copyFileSync(path.join(DEFAULT_DATA_DIR, f), path.join(dir, f));
    const prices = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA_DIR, 'prices.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify({ ...prices, entries }));
    return dir;
  }
  const run = async (t, { entries = ENTRIES, keys = ['fal'], route, argv = ['prices', '--check', '--json'] }) => {
    const e = createEnvironment(t, { dataDir: dataDir(t, entries), env: keysFor(...keys), routes: route ? [route] : [] });
    const r = await e.run(argv);
    assert.equal(r.code, 0, r.stderr);
    return { e, r, calls: pricingCalls(e.calls) };
  };
  const find = (r, model, when) =>
    r.json.results.find((x) => x.model === model && JSON.stringify(x.when) === JSON.stringify(when));
  const GOOD = {
    [NANO]: price(NANO, 0.15, 'images'), [S25]: price(S25, 0.0214, '1000 tokens'),
    [FAST]: price(FAST, 0.02, '1000 tokens'), [MINI]: price(MINI, 0.014, '1000 tokens'),
  };
  // Answered in the reverse of the request order, so pairing prices by position would mismatch them.
  const reversed = (table) => falRoute(table, { reverse: true });

  test('sends one request listing each distinct endpoint once, and compares by endpoint', async (t) => {
    const { r, calls } = await run(t, { route: reversed(GOOD) });
    assert.equal(calls.length, 1);
    const asked = endpointsOf(calls[0].url);
    assert.deepEqual([...asked].sort(), [FAST, MINI, NANO, S25].sort());
    assert.equal(new Set(asked).size, asked.length, 'no duplicate endpoint_id');
    assert.equal(find(r, 'seedance-2.0-mini', { resolution: '480p' }).status, 'changed');
    approx(find(r, 'seedance-2.0-mini', { resolution: '480p' }).liveUsd, 0.014);
    assert.equal(find(r, 'seedance-2.0-mini', { resolution: '720p' }).status, 'changed');
    assert.equal(find(r, 'seedance-2.0-fast', { resolution: '480p' }).status, 'changed');
    approx(find(r, 'seedance-2.0-fast', { resolution: '480p' }).liveUsd, 0.02);
    assert.equal(find(r, 'seedance-2.5', { resolution: '720p' }).status, 'same');
    assert.equal(find(r, 'nano-banana-pro', { size: '1K' }).status, 'same');
  });

  test('flagged entries are unchecked, with the base price as the reason, and never compared', async (t) => {
    const { r } = await run(t, { route: reversed(GOOD) });
    for (const x of [find(r, 'nano-banana-pro', { size: '4K' }), find(r, 'seedance-2.5', { resolution: '1080p' })]) {
      assert.equal(x.status, 'unchecked', x.model);
      assert.match(x.reason, /base price/i);
      assert.equal(x.liveUsd, null);
    }
  });

  for (const [name, response] of [
    ['429 with retry-after', { status: 429, headers: { 'retry-after': '30' }, json: { error: 'rate limited' } }],
    ['500', { status: 500, json: {} }],
    ['a network error', { error: new TypeError('fetch failed') }],
  ]) {
    test(`${name}: every comparable fal entry is unavailable after a single request`, async (t) => {
      const { r, calls } = await run(t, { route: { method: 'GET', url: PRICING_URL, ...response } });
      assert.equal(calls.length, 1, 'fal is not asked again per entry');
      const comparable = [['seedance-2.0-mini', { resolution: '480p' }], ['seedance-2.0-mini', { resolution: '720p' }],
        ['seedance-2.0-fast', { resolution: '480p' }], ['seedance-2.5', { resolution: '720p' }],
        ['nano-banana-pro', { size: '1K' }]];
      for (const [model, when] of comparable) {
        assert.equal(find(r, model, when).status, 'unavailable', `${model} ${JSON.stringify(when)}`);
      }
      assert.equal(find(r, 'nano-banana-pro', { size: '4K' }).status, 'unchecked');
      assert.equal(find(r, 'seedance-2.5', { resolution: '1080p' }).status, 'unchecked');
    });
  }

  test('an endpoint missing from the answer is unavailable for its own entries only', async (t) => {
    const { [S25]: _gone, ...rest } = GOOD;
    const { r } = await run(t, { route: reversed(rest) });
    assert.equal(find(r, 'seedance-2.5', { resolution: '720p' }).status, 'unavailable');
    assert.equal(find(r, 'nano-banana-pro', { size: '1K' }).status, 'same');
    assert.equal(find(r, 'seedance-2.0-mini', { resolution: '480p' }).status, 'changed');
  });

  test('a price in another currency is unavailable', async (t) => {
    const { r } = await run(t, { route: reversed({ ...GOOD, [NANO]: price(NANO, 0.15, 'images', 'EUR') }) });
    assert.equal(find(r, 'nano-banana-pro', { size: '1K' }).status, 'unavailable');
    assert.equal(find(r, 'seedance-2.5', { resolution: '720p' }).status, 'same');
  });

  test('a unit that does not match the entry is unchecked and names the unit', async (t) => {
    const { r } = await run(t, { route: reversed({ ...GOOD, [S25]: price(S25, 0.5, 'processed megapixels') }) });
    const x = find(r, 'seedance-2.5', { resolution: '720p' });
    assert.equal(x.status, 'unchecked');
    assert.match(x.reason, /processed megapixels/);
  });

  test('checking one model requests only that model\'s endpoints', async (t) => {
    const { r, calls } = await run(t, { route: reversed(GOOD), argv: ['prices', 'seedance-2.5', '--check', '--json'] });
    assert.equal(calls.length, 1);
    assert.deepEqual(endpointsOf(calls[0].url), [S25]);
    assert.deepEqual([...new Set(r.json.results.map((x) => x.model))], ['seedance-2.5']);
  });

  test('fal is not contacted when no selected entry can be compared', async (t) => {
    const { r, e } = await run(t, { argv: ['prices', 'nano-banana-pro', '--check', '--json'], entries: [img('4K', 0.30, NO)] });
    assert.equal(e.calls.length, 0);
    assert.equal(find(r, 'nano-banana-pro', { size: '4K' }).status, 'unchecked');
  });

  test('without a fal key entries need a key and fal is not contacted', async (t) => {
    const { r, e } = await run(t, { keys: [] });
    assert.equal(e.calls.length, 0);
    assert.equal(find(r, 'seedance-2.5', { resolution: '720p' }).status, 'unchecked');
    assert.match(find(r, 'seedance-2.5', { resolution: '720p' }).reason, /needs a key/i);
    assert.match(find(r, 'nano-banana-pro', { size: '1K' }).reason, /needs a key/i);
  });
});
