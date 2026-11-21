// `prices --check` compares bundled prices with live sources.
// Uses test/fixtures/data-live/: 3 Kie entries (480p 0.019/s, 720p 0.041/s, seedream-5-pro 1K 0.035/image),
// Replicate (2 entries, one verified 2026-10-01 so it is stale), WaveSpeed 480p 0.054/s, and fal 480p
// 0.007 per 1k tokens. Today is 2026-11-21.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createEnvironment, keysFor, approx, KEYS } from './helpers/harness.js';
import { DESC, row, kieRoutes, listCalls } from './helpers/kie-price-list.js';

const DATA_LIVE = fileURLToPath(new URL('./fixtures/data-live/', import.meta.url));
const CHECK = ['prices', '--check', '--json'];

// Kie rows: 480p is 0.26% off (same), 720p is 10% off (changed), the seedream row is absent (missing).
const KIE_ROWS = [row(DESC.mini480, { usd: 0.01905 }), row(DESC.mini720, { usd: 0.045 })];

const result = (r, provider, model, when) =>
  r.json.results.find((x) => x.provider === provider && x.model === model
    && JSON.stringify(x.when) === JSON.stringify(when));
const WHEN_480 = { resolution: '480p' };
const WHEN_720 = { resolution: '720p' };

const make = (t, { keys = [], routes = [], kie = KIE_ROWS } = {}) =>
  createEnvironment(t, { dataDir: DATA_LIVE, env: keysFor(...keys), routes: [...kieRoutes(kie), ...routes] });

const wavespeedPrice = (perSecond) => ({
  method: 'POST', url: 'https://api.wavespeed.ai/api/v3/model/price',
  responses: [(req) => ({ status: 200, json: { code: 200, message: 'success',
    data: { price: perSecond * 2 * req.body.input.duration, discounted_price: perSecond * req.body.input.duration } } })],
});
const falPricing = (unitPrice, unit = '1000 tokens') => ({
  method: 'GET', url: /^https:\/\/api\.fal\.ai\/v1\/models\/pricing/,
  responses: [(req) => {
    const endpoint = new URL(req.url).searchParams.get('endpoint_id');
    return { status: 200, json: { prices: [{ endpoint_id: endpoint, unit_price: unitPrice, unit, currency: 'USD' }] } };
  }],
});

describe('prices --check --json: shape', () => {
  test('prints { checkedOn, results, summary, stale } and exits 0', async (t) => {
    const e = make(t);
    const r = await e.run(CHECK);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.keys(r.json).sort(), ['checkedOn', 'results', 'stale', 'summary']);
    assert.match(r.json.checkedOn, /^2026-11-21/);
    assert.deepEqual(Object.keys(r.json.summary).sort(), ['changed', 'missing', 'same', 'unavailable', 'unchecked']);
    assert.equal(r.json.results.length, 7, 'one result per bundled price entry');
    for (const x of r.json.results) {
      assert.deepEqual(['provider', 'model', 'mode', 'when', 'bundledUsd', 'liveUsd', 'status'].filter((k) => !(k in x)), [], x.provider);
      assert.ok(['same', 'changed', 'missing', 'unavailable', 'unchecked'].includes(x.status), x.status);
    }
    const total = Object.values(r.json.summary).reduce((a, b) => a + b, 0);
    assert.equal(total, r.json.results.length, 'summary counts add up to the number of results');
  });

  test('bundledUsd is the entry\'s unit price', async (t) => {
    const r = await make(t).run(CHECK);
    approx(result(r, 'kie', 'seedance-2.0-mini', WHEN_480).bundledUsd, 0.019);
    approx(result(r, 'kie', 'seedream-5-pro', { size: '1K' }).bundledUsd, 0.035);
    approx(result(r, 'fal', 'seedance-2.0-mini', WHEN_480).bundledUsd, 0.007);
  });

  test('stale lists bundled entries older than 14 days', async (t) => {
    const r = await make(t).run(CHECK);
    assert.equal(r.json.stale.length, 1);
    const text = JSON.stringify(r.json.stale[0]);
    assert.ok(text.includes('replicate') && text.includes('seedance-2.0-mini') && text.includes('2026-10-01'), text);
  });

  test('--check with a model name only checks that model\'s entries', async (t) => {
    const r = await make(t).run(['prices', 'seedream-5-pro', '--check', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.results.map((x) => x.model), ['seedream-5-pro']);
  });
});

describe('prices --check: Kie needs no key', () => {
  test('same (within 0.5%), changed, and missing rows', async (t) => {
    const e = make(t);                                     // no keys at all
    const r = await e.run(CHECK);
    assert.equal(r.code, 0, r.stderr);

    const same = result(r, 'kie', 'seedance-2.0-mini', WHEN_480);
    assert.equal(same.status, 'same');
    approx(same.liveUsd, 0.01905);

    const changed = result(r, 'kie', 'seedance-2.0-mini', WHEN_720);
    assert.equal(changed.status, 'changed');
    approx(changed.bundledUsd, 0.041);
    approx(changed.liveUsd, 0.045);

    assert.equal(result(r, 'kie', 'seedream-5-pro', { size: '1K' }).status, 'missing');
    assert.equal(listCalls(e.calls).length, 1);
  });

  test('a difference just over 0.5% is changed, just under is same', async (t) => {
    const rows = [row(DESC.mini480, { usd: 0.019 * 1.006 }), row(DESC.mini720, { usd: 0.041 * 1.004 })];
    const r = await make(t, { kie: rows }).run(CHECK);
    assert.equal(result(r, 'kie', 'seedance-2.0-mini', WHEN_480).status, 'changed');
    assert.equal(result(r, 'kie', 'seedance-2.0-mini', WHEN_720).status, 'same');
  });

  test('a row with the wrong creditUnit counts as missing', async (t) => {
    const rows = [row(DESC.mini480, { usd: 0.019, unit: 'per image' })];
    const r = await make(t, { kie: rows }).run(CHECK);
    assert.equal(result(r, 'kie', 'seedance-2.0-mini', WHEN_480).status, 'missing');
  });

  test('a failing list makes every Kie entry unavailable, not missing', async (t) => {
    const e = createEnvironment(t, { dataDir: DATA_LIVE, routes: kieRoutes({ status: 503, json: { code: 503 } }) });
    const r = await e.run(CHECK);
    assert.equal(r.code, 0, r.stderr);
    for (const x of r.json.results.filter((y) => y.provider === 'kie')) assert.equal(x.status, 'unavailable', x.model);
    assert.equal(r.json.summary.unavailable, 3);
    assert.equal(r.json.summary.missing, 0);
  });
});

describe('prices --check: providers without a source or a key', () => {
  test('with no keys: Kie checked, Replicate "no price API", WaveSpeed and fal "needs a key"', async (t) => {
    const e = make(t);
    const r = await e.run(CHECK);
    assert.deepEqual(r.json.summary, { same: 1, changed: 1, missing: 1, unavailable: 0, unchecked: 4 });
    for (const x of r.json.results.filter((y) => y.provider === 'replicate')) {
      assert.equal(x.status, 'unchecked');
      assert.match(x.reason, /no price API/i);
    }
    for (const p of ['wavespeed', 'fal']) {
      const x = result(r, p, 'seedance-2.0-mini', WHEN_480);
      assert.equal(x.status, 'unchecked', p);
      assert.match(x.reason, /needs a key/i, p);
    }
    assert.deepEqual(e.calls.filter((c) => !c.url.includes('api.kie.ai')), [], 'only the Kie list is contacted');
  });

  test('the output never names the environment variables or key formats (it may end up in CI logs)', async (t) => {
    const e = make(t);
    await e.run(CHECK);
    await e.run(['prices', '--check']);
    const out = e.allOutput();
    for (const v of ['WAVESPEED_API_KEY', 'FAL_KEY', 'KIE_API_KEY', 'REPLICATE_API_TOKEN']) {
      assert.ok(!out.includes(v), `output must not mention ${v}`);
    }
  });

  test('Replicate is unchecked with a key too, and is never contacted', async (t) => {
    const e = make(t, { keys: ['replicate'] });
    const r = await e.run(CHECK);
    assert.equal(result(r, 'replicate', 'seedance-2.0-mini', WHEN_480).status, 'unchecked');
    assert.deepEqual(e.calls.filter((c) => c.url.includes('replicate')), []);
  });
});

describe('prices --check: WaveSpeed with a key', () => {
  test('compares the live request price divided by the request duration', async (t) => {
    // The fake charges 0.06 per second whatever duration the check chooses (and a list price twice that).
    const e = make(t, { keys: ['wavespeed'], routes: [wavespeedPrice(0.06)] });
    const r = await e.run(CHECK);
    assert.equal(r.code, 0, r.stderr);
    const x = result(r, 'wavespeed', 'seedance-2.0-mini', WHEN_480);
    assert.equal(x.status, 'changed');
    approx(x.bundledUsd, 0.054);
    approx(x.liveUsd, 0.06);

    const price = e.calls.find((c) => c.url === 'https://api.wavespeed.ai/api/v3/model/price');
    assert.equal(price.body.model_id, 'bytedance/seedance-2.0-mini/text-to-video');
    assert.equal(price.body.input.resolution, '480p', 'the request is built from the entry\'s `when`');
    assert.equal(typeof price.body.input.duration, 'number');
    assert.ok(!('inputs' in price.body));
  });

  test('uses the discounted price: a matching per-second price is "same"', async (t) => {
    const e = make(t, { keys: ['wavespeed'], routes: [wavespeedPrice(0.054)] });
    const r = await e.run(CHECK);
    const x = result(r, 'wavespeed', 'seedance-2.0-mini', WHEN_480);
    assert.equal(x.status, 'same');
    approx(x.liveUsd, 0.054);
  });

  test('a failing price call is "unavailable"', async (t) => {
    const e = make(t, { keys: ['wavespeed'], routes: [
      { method: 'POST', url: 'https://api.wavespeed.ai/api/v3/model/price', status: 503, json: {} }] });
    const r = await e.run(CHECK);
    assert.equal(result(r, 'wavespeed', 'seedance-2.0-mini', WHEN_480).status, 'unavailable');
  });

  test('fal stays "needs a key" and is not contacted', async (t) => {
    const e = make(t, { keys: ['wavespeed'], routes: [wavespeedPrice(0.054)] });
    const r = await e.run(CHECK);
    const x = result(r, 'fal', 'seedance-2.0-mini', WHEN_480);
    assert.equal(x.status, 'unchecked');
    assert.match(x.reason, /needs a key/i);
    assert.deepEqual(e.calls.filter((c) => c.url.includes('fal.')), []);
  });

  test('the key is not printed', async (t) => {
    const e = make(t, { keys: ['wavespeed'], routes: [wavespeedPrice(0.054)] });
    await e.run(CHECK);
    assert.ok(!e.allOutput().includes(KEYS.WAVESPEED_API_KEY));
  });
});

describe('prices --check: fal with a key', () => {
  test('a perToken entry is compared on usdPer1kTokens when the unit is "1000 tokens"', async (t) => {
    const e = make(t, { keys: ['fal'], routes: [falPricing(0.014)] });
    const r = await e.run(CHECK);
    assert.equal(r.code, 0, r.stderr);
    const x = result(r, 'fal', 'seedance-2.0-mini', WHEN_480);
    assert.equal(x.status, 'changed');
    approx(x.bundledUsd, 0.007);
    approx(x.liveUsd, 0.014);
    const call = e.calls.find((c) => c.url.startsWith('https://api.fal.ai/v1/models/pricing'));
    assert.ok(new URL(call.url).searchParams.get('endpoint_id').startsWith('bytedance/seedance-2.0/mini/'),
      'asks about the entry\'s endpoint');
  });

  test('an unchanged token price is "same"', async (t) => {
    const e = make(t, { keys: ['fal'], routes: [falPricing(0.007)] });
    const r = await e.run(CHECK);
    assert.equal(result(r, 'fal', 'seedance-2.0-mini', WHEN_480).status, 'same');
  });

  test('a unit that does not match the pricing type is not compared as if it did', async (t) => {
    const e = make(t, { keys: ['fal'], routes: [falPricing(0.5, 'image')] });
    const r = await e.run(CHECK);
    const x = result(r, 'fal', 'seedance-2.0-mini', WHEN_480);
    assert.notEqual(x.status, 'same');
    assert.notEqual(x.status, 'changed');
  });

  test('WaveSpeed stays "needs a key" and is not contacted', async (t) => {
    const e = make(t, { keys: ['fal'], routes: [falPricing(0.007)] });
    const r = await e.run(CHECK);
    const x = result(r, 'wavespeed', 'seedance-2.0-mini', WHEN_480);
    assert.equal(x.status, 'unchecked');
    assert.deepEqual(e.calls.filter((c) => c.url.includes('wavespeed')), []);
  });
});

describe('prices --check: exit code and human output', () => {
  test('the exit code is 0 even when prices changed', async (t) => {
    const r = await make(t, { keys: ['wavespeed', 'fal'], routes: [wavespeedPrice(0.06), falPricing(0.014)] }).run(CHECK);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.changed, 3);
    assert.equal(r.json.summary.same, 1);
  });

  test('without --json it prints a readable summary that mentions the changed rows', async (t) => {
    const e = make(t);
    const r = await e.run(['prices', '--check']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json, null, 'not JSON');
    assert.match(r.stdout, /changed/i);
    assert.ok(r.stdout.includes('seedance-2.0-mini'));
    assert.ok(r.stdout.includes('0.041') && r.stdout.includes('0.045'), 'shows the old and the new price');
    assert.match(r.stdout, /missing/i);
    assert.ok(r.stdout.includes('seedream-5-pro'));
  });
});
