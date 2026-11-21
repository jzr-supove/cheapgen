// Provider request bodies are built from each provider entry's `request` block,
// using the real data/ catalog. Also pins that adapters keep their default fields when `request` is absent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, DEFAULT_DATA_DIR } from '../src/catalog.js';
import { buildCanonicalRequest } from '../src/request.js';
import { supports, ADAPTERS } from '../src/providers/index.js';
import { DATA_DIR, PROMPT } from './helpers/harness.js';

const real = loadCatalog(DEFAULT_DATA_DIR);
const fixtureCatalog = loadCatalog(DATA_DIR);
const IMAGE_URL = 'https://cdn.cheapgen-test.example/in/first-frame.png';

const canonical = (catalog, model, flags = {}) =>
  buildCanonicalRequest(model, { prompt: PROMPT, ...flags }, catalog, { cwd: process.cwd(), requirePrompt: true });

function build(catalog, provider, request) {
  const s = supports(catalog, provider, request);
  assert.ok(s.ok, `${provider} should offer the request: ${s.reason}`);
  const imageUrl = request.image ? request.image : undefined;
  return ADAPTERS[provider].buildRequest(request, { entry: s.entry, imageUrl });
}
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

describe('image requests from the request block', () => {
  test('Kie seedream-5-pro 2K sends quality "high" and aspect_ratio, and no size or resolution', () => {
    const { body, url } = build(real, 'kie', canonical(real, 'seedream-5-pro', { size: '2K', aspect: '16:9' }));
    assert.equal(url, 'https://api.kie.ai/api/v1/jobs/createTask');
    assert.equal(body.model, 'seedream/5-pro-text-to-image');
    assert.equal(body.input.quality, 'high');
    assert.equal(body.input.aspect_ratio, '16:9');
    assert.ok(!has(body.input, 'size'), 'no size field');
    assert.ok(!has(body.input, 'resolution'), 'no resolution field');
  });

  test('Kie seedream-5-pro 1K maps to quality "basic"', () => {
    const { body } = build(real, 'kie', canonical(real, 'seedream-5-pro', { size: '1K' }));
    assert.equal(body.input.quality, 'basic');
  });

  test('Kie seedream-5.5 1.5K sends size "1.5K"', () => {
    const { body } = build(real, 'kie', canonical(real, 'seedream-5.5', { size: '1.5K' }));
    assert.equal(body.input.size, '1.5K');
    assert.ok(!has(body.input, 'resolution'));
  });

  test('WaveSpeed seedream-5.5 2K sends resolution "2k" to the bare model URL (no trailing slash or suffix)', () => {
    const { body, url } = build(real, 'wavespeed', canonical(real, 'seedream-5.5', { size: '2K' }));
    assert.equal(url, 'https://api.wavespeed.ai/api/v3/bytedance/seedream-v5.5');
    assert.equal(body.resolution, '2k');
  });

  test('WaveSpeed flux-2-pro 1K 16:9 sends the pixel size "1360*768" and no aspect_ratio', () => {
    const { body } = build(real, 'wavespeed', canonical(real, 'flux-2-pro', { size: '1K', aspect: '16:9' }));
    assert.equal(body.size, '1360*768');
    assert.ok(!has(body, 'aspect_ratio'));
  });

  test('fal seedream-5.5 1K 1:1 sends image_size {width, height} and no aspect_ratio', () => {
    const { body } = build(real, 'fal', canonical(real, 'seedream-5.5', { size: '1K', aspect: '1:1' }));
    assert.deepEqual(body.image_size, { width: 1024, height: 1024 });
    assert.ok(!has(body, 'aspect_ratio'));
    assert.ok(!has(body, 'resolution'));
  });

  test('fal nano-banana-2.1 posts to the bare endpoint and sends resolution "1K"', () => {
    const { body, url } = build(real, 'fal', canonical(real, 'nano-banana-2.1', { size: '1K' }));
    assert.equal(url, 'https://queue.fal.run/google/nano-banana-2.1');
    assert.equal(body.resolution, '1K');
    assert.equal(body.aspect_ratio, '16:9', 'no aspect:false here, so the ratio is sent');
  });

  test('Replicate flux-2-pro 2K sends resolution "4 MP"', () => {
    const { body } = build(real, 'replicate', canonical(real, 'flux-2-pro', { size: '2K' }));
    assert.equal(body.input.resolution, '4 MP');
  });

  test('every pixel-sending provider entry sends exactly the pixels of the canonical request', () => {
    for (const [model, m] of Object.entries(real.models)) {
      if (m.kind !== 'image') continue;
      for (const [provider, entry] of Object.entries(m.providers)) {
        const mode = entry.request?.size?.pixels;
        if (!mode) continue;
        for (const size of entry.sizes ?? m.sizes) {
          const r = canonical(real, model, { size, aspect: '3:4' });
          const [w, h] = real.frameSizes[model][size]['3:4'];
          assert.deepEqual(r.pixels, [w, h], `${model} ${size}`);
          const { body } = build(real, provider, r);
          const sent = body[entry.request.size.field] ?? body.input?.[entry.request.size.field];
          assert.deepEqual(sent, mode === 'object' ? { width: w, height: h } : `${w}*${h}`, `${provider} ${model} ${size}`);
        }
      }
    }
  });
});

describe('canonical request pixels', () => {
  test('an image model with a pixel table carries pixels [width, height]', () => {
    assert.deepEqual(canonical(real, 'flux-2-pro', { size: '1K', aspect: '16:9' }).pixels, [1360, 768]);
    assert.deepEqual(canonical(real, 'seedream-5.5', { size: '1.5K', aspect: '1:1' }).pixels, [1536, 1536]);
  });

  test('an image model without a pixel table (nano-banana-2.1) has pixels: null', () => {
    const r = canonical(real, 'nano-banana-2.1', { size: '2K' });
    assert.ok('pixels' in r, 'pixels is always present on image requests');
    assert.equal(r.pixels, null);
  });
});

describe('image-to-video aspect_ratio (request.imageToVideoAspect)', () => {
  const i2v = (model, extra = {}) => canonical(real, model, { image: IMAGE_URL, aspect: '9:16', ...extra });
  const aspectOf = (provider, r) => {
    const { body } = build(real, provider, r);
    return (body.input ?? body);
  };

  test('Kie seedance-2.5 sends "adaptive"', () => {
    assert.equal(aspectOf('kie', i2v('seedance-2.5')).aspect_ratio, 'adaptive');
  });

  test('Replicate seedance-2.5 sends "adaptive"', () => {
    assert.equal(aspectOf('replicate', i2v('seedance-2.5')).aspect_ratio, 'adaptive');
  });

  test('fal sends "auto"', () => {
    assert.equal(aspectOf('fal', i2v('seedance-2.5')).aspect_ratio, 'auto');
    assert.equal(aspectOf('fal', i2v('seedance-2.0')).aspect_ratio, 'auto');
  });

  test('WaveSpeed omits aspect_ratio (the output follows the image)', () => {
    assert.ok(!has(aspectOf('wavespeed', i2v('seedance-2.5')), 'aspect_ratio'));
    assert.ok(!has(aspectOf('wavespeed', i2v('seedance-2.0')), 'aspect_ratio'));
  });

  test('Kie seedance-2.0 keeps the requested ratio', () => {
    assert.equal(aspectOf('kie', i2v('seedance-2.0')).aspect_ratio, '9:16');
  });

  test('the image URL is still sent', () => {
    for (const p of ['kie', 'replicate', 'wavespeed', 'fal']) {
      const text = JSON.stringify(build(real, p, i2v('seedance-2.5')).body);
      assert.ok(text.includes(IMAGE_URL), `${p} sends the first frame`);
    }
  });

  test('text-to-video always sends the requested ratio, on every provider and model', () => {
    for (const model of ['seedance-2.0-mini', 'seedance-2.0', 'seedance-2.5']) {
      const r = canonical(real, model, { aspect: '9:16' });
      for (const p of ['kie', 'replicate', 'wavespeed', 'fal']) {
        assert.equal(aspectOf(p, r).aspect_ratio, '9:16', `${p} ${model}`);
      }
    }
  });
});

describe('adapters keep their default fields when the provider entry has no `request` block', () => {
  // test/fixtures/data/models.json has no request blocks at all.
  const img = canonical(fixtureCatalog, 'seedream-5-lite', { size: '2K', aspect: '4:3' });

  test('image: Kie resolution, Replicate size, WaveSpeed size, fal resolution, each with aspect_ratio', () => {
    const kie = build(fixtureCatalog, 'kie', img).body.input;
    assert.deepEqual([kie.aspect_ratio, kie.resolution], ['4:3', '2K']);
    const rep = build(fixtureCatalog, 'replicate', img).body.input;
    assert.deepEqual([rep.aspect_ratio, rep.size], ['4:3', '2K']);
    const ws = build(fixtureCatalog, 'wavespeed', img).body;
    assert.deepEqual([ws.aspect_ratio, ws.size], ['4:3', '2K']);
    const fal = build(fixtureCatalog, 'fal', img).body;
    assert.deepEqual([fal.aspect_ratio, fal.resolution], ['4:3', '2K']);
  });

  test('image: the endpoint still gets the mode suffix', () => {
    assert.equal(build(fixtureCatalog, 'wavespeed', img).url,
      'https://api.wavespeed.ai/api/v3/bytedance/seedream-v5.0-lite/text-to-image');
    assert.equal(build(fixtureCatalog, 'fal', img).url,
      'https://queue.fal.run/fal-ai/bytedance/seedream/v5/lite/text-to-image');
  });

  test('image-to-video sends the requested ratio on every provider', () => {
    const r = canonical(fixtureCatalog, 'seedance-2.5', { image: IMAGE_URL, aspect: '9:16' });
    for (const p of ['kie', 'replicate', 'wavespeed', 'fal']) {
      const { body } = build(fixtureCatalog, p, r);
      assert.equal((body.input ?? body).aspect_ratio, '9:16', p);
    }
  });
});
