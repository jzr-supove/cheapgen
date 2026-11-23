// 4K output for Seedance 2.0 and 2.5, run against the real data/ files.
// Providers are faked; nothing here touches the network or spends credits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, DEFAULT_DATA_DIR } from '../src/catalog.js';
import { createEnvironment, keysFor, runArgs, quoteArgs, approx, leafValues } from './helpers/harness.js';
import { routesFor, submitCalls } from './helpers/providers.js';
import { row, kieRoutes, LIST_URL } from './helpers/kie-price-list.js';

const catalog = loadCatalog(DEFAULT_DATA_DIR);
const FOUR_K_MODELS = ['seedance-2.0', 'seedance-2.5'];
const NO_4K_MODELS = ['seedance-2.0-mini', 'seedance-2.0-fast', 'seedance-2.5-flash'];
const KIE_DESC = { 'seedance-2.0': 'bytedance/seedance-2, 4K no video input', 'seedance-2.5': 'bytedance/seedance-2-5, 4K no video' };
const FAL_ENDPOINT = { 'seedance-2.0': 'bytedance/seedance-2.0/text-to-video', 'seedance-2.5': 'bytedance/seedance-2.5/text-to-video' };
const PRICING_URL = /^https:\/\/api\.fal\.ai\/v1\/models\/pricing/;
const kieDown = { method: 'POST', url: LIST_URL, status: 503, json: {} };
const quotes = (r) => Object.fromEntries(r.json.quotes.map((q) => [q.provider, q]));
const tokens = (w, h, seconds) => (w * h * seconds * 24) / 1024;

const fourK = (model) => catalog.prices.entries.filter((e) => e.model === model && e.when?.resolution === '4k');

describe('4k is offered by the right models', () => {
  test('models --json lists 4k for seedance-2.0 and 2.5 only', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR });
    const r = await e.run(['models', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const byId = Object.fromEntries(r.json.models.map((m) => [m.id, m]));
    for (const id of FOUR_K_MODELS) {
      assert.ok(byId[id].resolutions.includes('4k'), `${id} offers 4k`);
      assert.ok(byId[id].resolutions.includes('1080p'), `${id} keeps 1080p`);
    }
    for (const id of NO_4K_MODELS) assert.ok(!byId[id].resolutions.includes('4k'), `${id} has no 4k`);
  });

  test('the models table shows 4k for those two models', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR });
    const r = await e.run(['models']);
    const line = (id) => r.stdout.split('\n').find((l) => l.startsWith(`${id} `));
    for (const id of FOUR_K_MODELS) assert.match(line(id), /4k/, id);
    for (const id of NO_4K_MODELS) assert.doesNotMatch(line(id), /4k/, id);
  });

  for (const id of NO_4K_MODELS) {
    test(`quote ${id} --res 4k is a usage error (exit 2) naming the resolutions it has`, async (t) => {
      const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR });
      const r = await e.run(quoteArgs(id, '--res', '4k'));
      assert.equal(r.code, 2);
      assert.match(r.stderr + r.stdout, /doesn't support 4k/);
      assert.equal(e.calls.length, 0);
    });
  }
});

describe('frame sizes for 4k', () => {
  const EXPECTED = { '16:9': [3840, 2160], '9:16': [2160, 3840], '1:1': [2880, 2880],
    '4:3': [3326, 2494], '3:4': [2494, 3326], '21:9': [4398, 1886] };
  for (const series of FOUR_K_MODELS) {
    test(`${series} 4k sizes`, () => {
      assert.deepEqual(catalog.frameSizes[series]?.['4k'], EXPECTED);
    });
  }
});

describe('quote --res 4k with no keys', () => {
  test('seedance-2.0: four bundled quotes, Replicate cheapest', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR });
    const r = await e.run(quoteArgs('seedance-2.0', '--res', '4k', '--duration', '5'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.params.resolution, '4k');
    assert.deepEqual(r.json.quotes.map((q) => q.provider), ['replicate', 'kie', 'wavespeed', 'fal']);
    for (const q of r.json.quotes) assert.equal(q.source, 'bundled', q.provider);
    const q = quotes(r);
    approx(q.replicate.usd, 5.0);
    approx(q.kie.usd, 5.2);
    approx(q.wavespeed.usd, 5.4);
    approx(q.fal.usd, 7.776);
    assert.equal(e.calls.length, 0);
  });

  test('seedance-2.5: Kie cheapest, WaveSpeed and fal follow, Replicate is not offered', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR });
    const r = await e.run(quoteArgs('seedance-2.5', '--res', '4k', '--duration', '5'));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.quotes.map((q) => q.provider), ['kie', 'wavespeed', 'fal']);
    const q = quotes(r);
    approx(q.kie.usd, 6.275);
    approx(q.wavespeed.usd, 8.10);
    approx(q.fal.usd, 9.1368);
    assert.equal(e.calls.length, 0);
  });

  test('fal prices other aspect ratios from the 4k frame size', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR });
    const wide = await e.run(quoteArgs('seedance-2.0', '--res', '4k', '--duration', '5', '--aspect', '21:9'));
    approx(quotes(wide).fal.usd, tokens(4398, 1886, 5) / 1000 * 0.008);
    const square = await e.run(quoteArgs('seedance-2.0', '--res', '4k', '--duration', '5', '--aspect', '1:1'));
    approx(quotes(square).fal.usd, tokens(2880, 2880, 5) / 1000 * 0.008);
    const tall = await e.run(quoteArgs('seedance-2.5', '--res', '4k', '--duration', '5', '--aspect', '3:4'));
    approx(quotes(tall).fal.usd, tokens(2494, 3326, 5) / 1000 * 0.0094);
  });
});

describe('4k entries in prices.json', () => {
  for (const model of FOUR_K_MODELS) {
    test(`${model}: every 4k entry is sourced and verified on 2026-11-23`, () => {
      const entries = fourK(model);
      assert.deepEqual(entries.map((e) => e.provider).sort(),
        model === 'seedance-2.0' ? ['fal', 'kie', 'replicate', 'wavespeed'] : ['fal', 'kie', 'wavespeed']);
      for (const e of entries) {
        assert.match(e.sourceUrl ?? '', /^https:\/\//, e.provider);
        assert.equal(e.verifiedOn, '2026-11-23', e.provider);
      }
    });

    test(`${model}: Kie 4k carries the live price-list description, fal 4k opts out of the live unit price`, () => {
      const kie = fourK(model).find((e) => e.provider === 'kie');
      assert.equal(kie?.live?.kieDescription, KIE_DESC[model]);
      const fal = fourK(model).find((e) => e.provider === 'fal');
      assert.equal(fal?.live?.falUnitPrice, false);
    });
  }
});

describe('live prices and 4k', () => {
  test('a Kie live price row is used for the 4k quote', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('kie'),
      routes: kieRoutes([row(KIE_DESC['seedance-2.0'], { usd: 1.1, credit: 220 })]) });
    const r = await e.run(quoteArgs('seedance-2.0', '--res', '4k', '--duration', '5'));
    assert.equal(r.code, 0, r.stderr);
    const q = quotes(r).kie;
    assert.equal(q.source, 'live');
    approx(q.usd, 5.5);
  });

  test('a Kie live price row is used for seedance-2.5 4k too', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('kie'),
      routes: kieRoutes([row(KIE_DESC['seedance-2.5'], { usd: 1.3, credit: 260 })]) });
    const r = await e.run(quoteArgs('seedance-2.5', '--res', '4k', '--duration', '5'));
    assert.equal(quotes(r).kie.source, 'live');
    approx(quotes(r).kie.usd, 6.5);
  });

  for (const [model, base, bundled] of [['seedance-2.0', 0.014, 0.008], ['seedance-2.5', 0.0214, 0.0094]]) {
    test(`${model}: fal's live base price ($${base}/1k) is not used for 4k`, async (t) => {
      const endpoint = FAL_ENDPOINT[model];
      const falPrice = { method: 'GET', url: PRICING_URL, responses: [(req) => {
        const wanted = new URL(req.url).searchParams.getAll('endpoint_id');
        const prices = wanted.includes(endpoint)
          ? [{ endpoint_id: endpoint, unit_price: base, unit: '1000 tokens', currency: 'USD' }] : [];
        return { status: 200, json: { prices, next_cursor: null, has_more: false } };
      }] };
      const billing = { method: 'GET', url: /^https:\/\/api\.fal\.ai\/v1\/account\/billing/, status: 403, json: {} };
      const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('fal'), routes: [kieDown, billing, falPrice] });
      const r = await e.run(quoteArgs(model, '--res', '4k', '--duration', '5'));
      assert.equal(r.code, 0, r.stderr);
      const q = quotes(r).fal;
      assert.equal(q.source, 'bundled');
      approx(q.usd, tokens(3840, 2160, 5) / 1000 * bundled);
    });
  }
});

describe('run --res 4k', () => {
  for (const id of ['kie', 'replicate', 'wavespeed', 'fal']) {
    test(`${id}: the dry-run request body carries "4k" and nothing is submitted`, async (t) => {
      const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor(id), routes: routesFor(id) });
      const r = await e.run(runArgs('seedance-2.0', '--res', '4k', '--duration', '4', '--dry-run', '--provider', id));
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(r.json.provider, id);
      assert.ok(leafValues(r.json.request).includes('4k'), JSON.stringify(r.json.request));
      assert.equal(submitCalls(e.calls).length, 0);
    });
  }

  test('a real run without --yes stops at the default $1 limit (exit 4) and sends nothing', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('replicate'), routes: routesFor('replicate') });
    const r = await e.run(runArgs('seedance-2.0', '--res', '4k', '--duration', '4'));
    assert.equal(r.code, 4, `${r.stdout}\n${r.stderr}`);
    assert.equal(submitCalls(e.calls).length, 0);
    assert.equal(e.spendLines().length, 0);
  });

  test('with --yes the 4k job is submitted with "4k"', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('replicate'), routes: routesFor('replicate') });
    const r = await e.run(runArgs('seedance-2.0', '--res', '4k', '--duration', '4', '--yes'));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const sent = submitCalls(e.calls, 'replicate');
    assert.equal(sent.length, 1);
    assert.ok(leafValues(sent[0].body).includes('4k'));
  });
});

describe('the HEVC note', () => {
  const hevcLines = (r) => (r.stdout + '\n' + r.stderr).split('\n').filter((l) => /HEVC/.test(l) && /H\.265/i.test(l));
  const env = (t) => createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('kie'), routes: routesFor('kie') });
  const human = (res, ...extra) =>
    ['run', 'seedance-2.0', '--prompt', 'a calm lake at dawn', '--res', res, '--duration', '4', '--provider', 'kie', ...extra];

  test('a 4k dry run prints exactly one line about 10-bit H.265/HEVC', async (t) => {
    const r = await env(t).run(human('4k', '--dry-run'));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const lines = hevcLines(r);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /10-bit/);
  });

  test('a finished 4k run (--wait) prints the note once', async (t) => {
    const r = await env(t).run(human('4k', '--wait', '--yes'));
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(hevcLines(r).length, 1);
  });

  test('a 1080p run has no such note', async (t) => {
    const dryRun = await env(t).run(human('1080p', '--dry-run'));
    assert.equal(dryRun.code, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
    assert.equal(hevcLines(dryRun).length, 0);
    const waited = await env(t).run(human('1080p', '--wait', '--yes'));
    assert.equal(waited.code, 0, `${waited.stdout}\n${waited.stderr}`);
    assert.equal(hevcLines(waited).length, 0);
  });

  test('with --json, stdout is still a single JSON document', async (t) => {
    const e = env(t);
    for (const extra of [['--dry-run'], ['--wait', '--yes']]) {
      const r = await e.run([...human('4k', ...extra), '--json']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.doesNotThrow(() => JSON.parse(r.stdout), r.stdout);
    }
  });
});
