// Price calculation, including per-token formulas that use exact frame sizes.
// Unit-level on purpose: pure arithmetic, easiest to pin down here.
// Contract: cost(pricing, request, frameSizes) -> USD number. `request` carries
// { model, frameSeries, resolution|size, aspectRatio, duration, count }. `frameSizes` is the
// parsed frame-sizes.json: frameSizes[series][resolutionOrSize][aspectRatio] = [width, height].
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA_DIR, approx } from './helpers/harness.js';

const frameSizes = JSON.parse(fs.readFileSync(`${DATA_DIR}frame-sizes.json`, 'utf8'));
const loadCost = async () => (await import('../src/pricing/formulas.js')).cost;

describe('perSecond and perImage', () => {
  test('perSecond multiplies by duration and output count', async () => {
    const cost = await loadCost();
    const pricing = { type: 'perSecond', usd: 0.041 };
    const base = { model: 'seedance-2.0-mini', resolution: '720p', aspectRatio: '16:9' };
    approx(cost(pricing, { ...base, duration: 5, count: 1 }, frameSizes), 0.205);
    approx(cost(pricing, { ...base, duration: 8, count: 1 }, frameSizes), 0.328);
    approx(cost(pricing, { ...base, duration: 5, count: 2 }, frameSizes), 0.41);
  });

  test('perImage multiplies by count only, not by size', async () => {
    const cost = await loadCost();
    const pricing = { type: 'perImage', usd: 0.0275 };
    const base = { model: 'seedream-5-lite', aspectRatio: '1:1' };
    approx(cost(pricing, { ...base, size: '1K', count: 1 }, frameSizes), 0.0275);
    approx(cost(pricing, { ...base, size: '2K', count: 3 }, frameSizes), 0.0825);
  });
});

describe('perToken uses the exact ByteDance frame size', () => {
  const pricing = { type: 'perToken', usdPer1kTokens: 0.014, fps: 24 };
  const req = (series, resolution, aspectRatio, duration = 5) =>
    ({ model: series, frameSeries: series, resolution, aspectRatio, duration, count: 1 });

  // Expected values are worked out by hand: width*height*seconds*24/1024/1000*0.014.
  const cases = [
    ['seedance-2.0', '480p', '16:9', 864, 496, 0.70308],      // 2.0 uses 864x496, not 854x480
    ['seedance-2.5', '480p', '16:9', 854, 480, 0.672525],     // 2.5 uses 854x480
    ['seedance-2.0', '480p', '9:16', 496, 864, 0.70308],
    ['seedance-2.5', '480p', '9:16', 480, 854, 0.672525],
    ['seedance-2.0', '480p', '1:1', 640, 640, 0.672],
    ['seedance-2.0', '720p', '16:9', 1280, 720, 1.512],
    ['seedance-2.5', '720p', '16:9', 1280, 720, 1.512],
  ];
  for (const [series, res, aspect, w, h, expected] of cases) {
    test(`${series} ${res} ${aspect} is ${w}x${h} -> $${expected}`, async () => {
      const cost = await loadCost();
      approx(cost(pricing, req(series, res, aspect), frameSizes), expected, 1e-9);
      // cross-check against an independent computation of the documented formula
      approx(cost(pricing, req(series, res, aspect), frameSizes), (w * h * 5 * 24) / 1024 / 1000 * 0.014, 1e-9);
    });
  }

  test('the two series differ at 480p 16:9 (a nominal 854x480 would be wrong for 2.0)', async () => {
    const cost = await loadCost();
    const v20 = cost(pricing, req('seedance-2.0', '480p', '16:9'), frameSizes);
    const v25 = cost(pricing, req('seedance-2.5', '480p', '16:9'), frameSizes);
    assert.ok(v20 > v25, `2.0 (${v20}) should cost more than 2.5 (${v25}) at the same nominal size`);
  });

  test('cost scales linearly with duration', async () => {
    const cost = await loadCost();
    approx(cost(pricing, req('seedance-2.0', '480p', '16:9', 10), frameSizes), 2 * 0.70308, 1e-9);
  });
});

describe('perMegapixel', () => {
  const sizes = {
    'flux-2-pro': {
      '1K': { '1:1': [1000, 1000] },       // exactly 1.0 MP (1e6 definition)
      '1.2K': { '1:1': [1200, 1000] },     // 1.2 MP
      '2K': { '1:1': [2000, 2000] },       // 4.0 MP
      '2048': { '1:1': [2048, 2048] },     // 4.194304 MP (1e6) or exactly 4 MP (1024^2)
    },
  };
  const req = (size, count = 1) => ({ model: 'flux-2-pro', frameSeries: 'flux-2-pro', size, aspectRatio: '1:1', count });
  const base = { type: 'perMegapixel', usdPerRun: 0.01, usdPerOutputMp: 0.015, usdPerInputMp: 0, mpDefinition: 1e6, roundUp: true };

  test('exact whole megapixels', async () => {
    const cost = await loadCost();
    approx(cost(base, req('1K'), sizes), 0.01 + 1 * 0.015);
    approx(cost(base, req('2K'), sizes), 0.01 + 4 * 0.015);
  });

  test('roundUp rounds output megapixels up, otherwise the fraction is billed', async () => {
    const cost = await loadCost();
    approx(cost(base, req('1.2K'), sizes), 0.01 + 2 * 0.015);                       // ceil(1.2) = 2
    approx(cost({ ...base, roundUp: false }, req('1.2K'), sizes), 0.01 + 1.2 * 0.015);
  });

  test('mpDefinition decides what a megapixel is', async () => {
    const cost = await loadCost();
    approx(cost(base, req('2048'), sizes), 0.01 + 5 * 0.015);                       // ceil(4.19) = 5
    approx(cost({ ...base, mpDefinition: 1024 * 1024 }, req('2048'), sizes), 0.01 + 4 * 0.015);
  });

  test('applies per image when count > 1', async () => {
    const cost = await loadCost();
    approx(cost(base, req('2K', 2), sizes), 2 * (0.01 + 4 * 0.015));
  });
});

describe('tiered', () => {
  const sizes = {
    'seedream-5-pro': {
      '1K': { '1:1': [1024, 1024] },
      '1536': { '1:1': [1536, 1536] },
      '2K': { '1:1': [2048, 2048] },
    },
  };
  const pricing = { type: 'tiered', tiers: [{ maxPixels: 1536 * 1536, usd: 0.0675 }, { maxPixels: 2048 * 2048, usd: 0.135 }] };
  const req = (size, count = 1) => ({ model: 'seedream-5-pro', frameSeries: 'seedream-5-pro', size, aspectRatio: '1:1', count });

  test('picks the first tier that fits the output size, boundary included', async () => {
    const cost = await loadCost();
    approx(cost(pricing, req('1K'), sizes), 0.0675);
    approx(cost(pricing, req('1536'), sizes), 0.0675);
    approx(cost(pricing, req('2K'), sizes), 0.135);
  });

  test('multiplies by count', async () => {
    const cost = await loadCost();
    approx(cost(pricing, req('2K', 2), sizes), 0.27);
  });
});
