// Integrity of the real data/ files (models, prices, frame sizes, per-provider request blocks,
// Kie price-list descriptions) and the CLI running on them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, DEFAULT_DATA_DIR } from '../src/catalog.js';
import { supports, ADAPTERS } from '../src/providers/index.js';
import { bundledPrice } from '../src/pricing/index.js';
import { createEnvironment, approx } from './helpers/harness.js';

const catalog = loadCatalog(DEFAULT_DATA_DIR);
const NOW = new Date('2026-11-21T12:00:00Z');
const VIDEO = ['seedance-2.0-mini', 'seedance-2.0-fast', 'seedance-2.0', 'seedance-2.5-flash', 'seedance-2.5'];
const IMAGE = ['seedream-5.5', 'seedream-5-pro', 'seedream-5-lite', 'nano-banana-2.1', 'nano-banana-pro', 'flux-2-pro'];

describe('data/models.json', () => {
  test('has exactly the 11 canonical models with the right kind', () => {
    assert.deepEqual(Object.keys(catalog.models).sort(), [...VIDEO, ...IMAGE].sort());
    for (const id of VIDEO) assert.equal(catalog.models[id].kind, 'video', id);
    for (const id of IMAGE) assert.equal(catalog.models[id].kind, 'image', id);
  });

  test('Replicate offers neither seedance-2.5-flash nor seedream-5.5', () => {
    assert.equal(catalog.models['seedance-2.5-flash'].providers.replicate, undefined);
    assert.equal(catalog.models['seedream-5.5'].providers.replicate, undefined);
  });

  test('every other model is offered by all four providers', () => {
    for (const id of [...VIDEO, ...IMAGE]) {
      if (id === 'seedance-2.5-flash' || id === 'seedream-5.5') continue;
      assert.deepEqual(Object.keys(catalog.models[id].providers).sort(), ['fal', 'kie', 'replicate', 'wavespeed'], id);
    }
  });

  test('durations run from 4 s; 15 s max for the 2.0 family and 30 s for the 2.5 family', () => {
    for (const id of ['seedance-2.0-mini', 'seedance-2.0-fast', 'seedance-2.0']) {
      assert.deepEqual(catalog.models[id].durations, { min: 4, max: 15 }, id);
    }
    for (const id of ['seedance-2.5-flash', 'seedance-2.5']) {
      assert.deepEqual(catalog.models[id].durations, { min: 4, max: 30 }, id);
    }
  });

  test('video resolutions are 480p, 720p and 1080p, plus 4k only where ByteDance makes it natively', () => {
    const NATIVE_4K = new Set(['seedance-2.0', 'seedance-2.5']);
    const allowedFor = (id) => new Set(['480p', '720p', '1080p', ...(NATIVE_4K.has(id) ? ['4k'] : [])]);
    for (const id of NATIVE_4K) assert.ok(catalog.models[id].resolutions.includes('4k'), `${id} lists 4k`);
    for (const id of VIDEO) {
      const allowed = allowedFor(id);
      const m = catalog.models[id];
      for (const res of m.resolutions) assert.ok(allowed.has(res), `${id}: ${res}`);
      for (const [p, e] of Object.entries(m.providers)) {
        for (const res of e.resolutions ?? []) assert.ok(allowed.has(res), `${id}/${p}: ${res}`);
      }
    }
    for (const e of catalog.prices.entries) {
      if (!VIDEO.includes(e.model)) continue;
      const allowed = allowedFor(e.model);
      for (const res of [e.when?.resolution ?? []].flat()) assert.ok(allowed.has(res), `${e.provider} ${e.model}: ${res}`);
    }
    for (const [series, table] of Object.entries(catalog.frameSizes)) {
      if (!series.startsWith('seedance')) continue;
      const allowed = allowedFor(series);
      for (const res of Object.keys(table)) assert.ok(allowed.has(res), `${series}: ${res}`);
    }
  });

  test('provider-level options only narrow the model options', () => {
    for (const [id, m] of Object.entries(catalog.models)) {
      for (const [p, e] of Object.entries(m.providers)) {
        for (const r of e.resolutions ?? []) assert.ok(m.resolutions.includes(r), `${id}/${p} resolution ${r}`);
        for (const s of e.sizes ?? []) assert.ok(m.sizes.includes(s), `${id}/${p} size ${s}`);
        for (const a of e.aspectRatios ?? []) assert.ok(m.aspectRatios.includes(a), `${id}/${p} aspect ${a}`);
      }
    }
  });
});

describe('data/prices.json', () => {
  test('every entry has an https sourceUrl and a YYYY-MM-DD verifiedOn that is not in the future', () => {
    assert.ok(catalog.prices.entries.length > 0);
    for (const e of catalog.prices.entries) {
      const label = `${e.provider} ${e.model} ${JSON.stringify(e.when)}`;
      assert.match(e.sourceUrl ?? '', /^https:\/\/\S+$/, label);
      assert.match(e.verifiedOn ?? '', /^\d{4}-\d{2}-\d{2}$/, label);
      assert.ok(Date.parse(`${e.verifiedOn}T00:00:00Z`) <= Date.now(), `${label}: verifiedOn is in the future`);
    }
  });

  test('every Kie entry names its Kie list row in live.kieDescription', () => {
    const kie = catalog.prices.entries.filter((e) => e.provider === 'kie');
    assert.ok(kie.length > 0);
    for (const e of kie) {
      assert.equal(typeof e.live?.kieDescription, 'string', `${e.model} ${JSON.stringify(e.when)}`);
      assert.ok(e.live.kieDescription.trim().length > 0, `${e.model} ${JSON.stringify(e.when)}`);
    }
  });

  test('Kie entries that share one list row (e.g. "1/2K") carry the same bundled price', () => {
    const byRow = new Map();
    for (const e of catalog.prices.entries.filter((x) => x.provider === 'kie')) {
      const key = e.live.kieDescription;
      if (byRow.has(key)) assert.deepEqual(e.pricing, byRow.get(key).pricing, key);
      else byRow.set(key, e);
    }
  });

  test('every entry belongs to a provider that offers the model', () => {
    for (const e of catalog.prices.entries) {
      assert.ok(catalog.models[e.model]?.providers?.[e.provider], `${e.provider} ${e.model}`);
    }
  });

  // Everything a provider claims to offer must be priceable, or `quote` would show "unknown".
  test('every provider/model/mode/resolution-or-size/aspect that supports() accepts has a numeric bundled price', () => {
    let checked = 0;
    const missing = [];
    for (const [model, m] of Object.entries(catalog.models)) {
      for (const providerId of Object.keys(ADAPTERS)) {
        const options = m.kind === 'video' ? m.resolutions : m.sizes;
        for (const mode of m.modes) for (const option of options) for (const aspectRatio of m.aspectRatios) {
          const request = m.kind === 'video'
            ? { model, kind: 'video', frameSeries: m.frameSeries ?? model, mode, resolution: option, aspectRatio,
              duration: 5, audio: true, count: 1 }
            : { model, kind: 'image', frameSeries: m.frameSeries ?? model, mode, size: option, aspectRatio, count: 1 };
          if (!supports(catalog, providerId, request).ok) continue;
          checked += 1;
          const p = bundledPrice(catalog, providerId, request, NOW);
          if (typeof p.usd !== 'number' || !Number.isFinite(p.usd) || p.usd <= 0) {
            missing.push(`${providerId} ${model} ${mode} ${option} ${aspectRatio}: ${p.reason ?? p.usd}`);
          }
        }
      }
    }
    assert.ok(checked > 500, `expected a large matrix, checked ${checked}`);
    assert.deepEqual(missing, []);
  });
});

describe('data/frame-sizes.json', () => {
  test('providers that send explicit pixels have a size for every size x aspect of the model', () => {
    let withPixels = 0;
    for (const [model, m] of Object.entries(catalog.models)) {
      for (const [p, e] of Object.entries(m.providers)) {
        if (!e.request?.size?.pixels) continue;
        withPixels += 1;
        assert.ok(['object', 'W*H'].includes(e.request.size.pixels), `${model}/${p}`);
        for (const size of e.sizes ?? m.sizes) for (const aspect of e.aspectRatios ?? m.aspectRatios) {
          const px = catalog.frameSizes[m.frameSeries ?? model]?.[size]?.[aspect];
          assert.ok(Array.isArray(px) && px.length === 2 && px.every((n) => Number.isInteger(n) && n > 0),
            `${model}/${p}: no pixel size for ${size} ${aspect}`);
        }
      }
    }
    assert.ok(withPixels >= 5, 'seedream 5.5/5-pro/5-lite and flux-2-pro send pixels to fal or WaveSpeed');
  });

  test('image pixel sizes: sides are multiples of 16 and FLUX stays within 2048 per side', () => {
    for (const model of ['seedream-5.5', 'seedream-5-pro', 'seedream-5-lite', 'flux-2-pro']) {
      for (const [size, byAspect] of Object.entries(catalog.frameSizes[model])) {
        for (const [aspect, [w, h]] of Object.entries(byAspect)) {
          assert.equal(w % 16, 0, `${model} ${size} ${aspect} width ${w}`);
          assert.equal(h % 16, 0, `${model} ${size} ${aspect} height ${h}`);
          if (model === 'flux-2-pro') assert.ok(w <= 2048 && h <= 2048, `${model} ${size} ${aspect}`);
        }
      }
    }
  });

  test('every video series/resolution/aspect the models offer has a frame size', () => {
    for (const [model, m] of Object.entries(catalog.models)) {
      if (m.kind !== 'video') continue;
      for (const res of m.resolutions) for (const a of m.aspectRatios) {
        assert.ok(catalog.frameSizes[m.frameSeries]?.[res]?.[a], `${model} ${res} ${a}`);
      }
    }
  });
});

describe('spot checks against the researched prices', () => {
  const price = (provider, model, fields) => {
    const m = catalog.models[model];
    const request = { model, kind: m.kind, frameSeries: m.frameSeries ?? model, mode: m.modes[0], aspectRatio: '1:1',
      count: 1, ...(m.kind === 'video' ? { duration: 1, audio: true } : {}), ...fields };
    return bundledPrice(catalog, provider, request, NOW).usd;
  };

  test('Kie seedance-2.0-mini 480p is $0.019 per second', () => {
    approx(price('kie', 'seedance-2.0-mini', { resolution: '480p', aspectRatio: '16:9' }), 0.019);
    approx(price('kie', 'seedance-2.0-mini', { resolution: '480p', aspectRatio: '16:9', duration: 5 }), 0.095);
  });

  test('fal seedream-5-pro 1K 1:1 is $0.0675 (tiered on the pixels sent)', () => {
    approx(price('fal', 'seedream-5-pro', { size: '1K' }), 0.0675);
  });

  test('fal flux-2-pro is $0.03 at 1K 1:1 and $0.075 at 2K 1:1', () => {
    approx(price('fal', 'flux-2-pro', { size: '1K' }), 0.03);
    approx(price('fal', 'flux-2-pro', { size: '2K' }), 0.075);
  });

  test('Replicate flux-2-pro 2K is $0.075', () => {
    approx(price('replicate', 'flux-2-pro', { size: '2K' }), 0.075);
  });
});

describe('the real CLI on the real data', () => {
  test('quote seedance-2.0-mini --res 480p --duration 5 with no keys: four bundled quotes, Kie cheapest, no network', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR });
    const r = await e.run(['quote', 'seedance-2.0-mini', '--res', '480p', '--duration', '5', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.quotes.length, 4);
    assert.deepEqual(r.json.quotes.map((q) => q.source), ['bundled', 'bundled', 'bundled', 'bundled']);
    assert.equal(r.json.quotes[0].provider, 'kie');
    approx(r.json.quotes[0].usd, 0.095);
    for (const q of r.json.quotes) assert.ok(typeof q.usd === 'number' && q.usd > 0, q.provider);
    assert.deepEqual(r.json.quotes.map((q) => q.provider).sort(), ['fal', 'kie', 'replicate', 'wavespeed']);
    assert.equal(r.calls.length, 0);
  });
});
