// Provider details checked against each provider's docs: status states, upload hosts and
// fields, discounted prices, fal's pricing units.
// Adapters are called directly with the fake fetch; test/fixtures/README.md says which fixtures are recorded.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS, supports } from '../src/providers/index.js';
import { loadCatalog, DEFAULT_DATA_DIR } from '../src/catalog.js';
import { buildCanonicalRequest } from '../src/request.js';
import { createFakeFetch } from './helpers/fake-fetch.js';
import { fixture } from './helpers/providers.js';
import { PROMPT } from './helpers/harness.js';

const ctxWith = (fetch) => ({ key: 'test-key-ZZZZ9999', fetch, now: () => new Date('2026-11-21T12:00:00Z'), sleep: async () => {} });
const catalog = loadCatalog(DEFAULT_DATA_DIR);

function tempImage(t, name = 'frame.png') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapgen-img-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  return file;
}

describe('fal', () => {
  const STATUS = 'https://queue.fal.run/bytedance/seedance-2.0/requests/fal_req_001/status';
  const RESULT = 'https://queue.fal.run/bytedance/seedance-2.0/requests/fal_req_001';
  const meta = { endpoint: 'bytedance/seedance-2.0/text-to-video', statusUrl: STATUS, responseUrl: RESULT };

  test('COMPLETED with an error field is a failed job with a message', async () => {
    const fake = createFakeFetch([
      { method: 'GET', url: STATUS, status: 200, json: fixture('fal', 'status-completed-error') },
      // A naive adapter that goes on to read the result would see success here and be wrong.
      { method: 'GET', url: RESULT, status: 200, json: fixture('fal', 'result') },
    ]);
    const s = await ADAPTERS.fal.status('fal_req_001', ctxWith(fake.fetch), meta);
    assert.equal(s.state, 'failed');
    assert.deepEqual(s.outputs, []);
    assert.equal(typeof s.error?.message, 'string');
    assert.ok(s.error.message.includes('Invalid status code: 500'), 'the provider message is reported');
  });

  test('a result URL answering 422 is a failed job that is not a provider fault', async () => {
    const fake = createFakeFetch([
      { method: 'GET', url: STATUS, status: 200, json: fixture('fal', 'status-completed') },
      { method: 'GET', url: RESULT, status: 422, json: fixture('fal', 'result-422') },
    ]);
    const s = await ADAPTERS.fal.status('fal_req_001', ctxWith(fake.fetch), meta);
    assert.equal(s.state, 'failed');
    assert.equal(s.error.providerFault, false);
    assert.ok(s.error.message.includes('content checker'), 'the validation detail is reported');
  });

  test('a result URL answering 500 stays a provider fault', async () => {
    const fake = createFakeFetch([
      { method: 'GET', url: STATUS, status: 200, json: fixture('fal', 'status-completed') },
      { method: 'GET', url: RESULT, status: 500, json: { detail: 'Internal Server Error' } },
    ]);
    const s = await ADAPTERS.fal.status('fal_req_001', ctxWith(fake.fetch), meta);
    assert.equal(s.state, 'failed');
    assert.equal(s.error.providerFault, true);
  });

  test('a normal COMPLETED job still succeeds', async () => {
    const fake = createFakeFetch([
      { method: 'GET', url: STATUS, status: 200, json: fixture('fal', 'status-completed') },
      { method: 'GET', url: RESULT, status: 200, json: fixture('fal', 'result') },
    ]);
    const s = await ADAPTERS.fal.status('fal_req_001', ctxWith(fake.fetch), meta);
    assert.equal(s.state, 'succeeded');
    assert.deepEqual(s.outputs, ['https://cdn.cheapgen-test.example/out/fal-1.mp4']);
  });

  test('upload initiates at rest.fal.ai (not rest.alpha.fal.ai) with storage_type=fal-cdn-v3', async (t) => {
    const init = fixture('fal', 'upload-initiate');
    const fake = createFakeFetch([
      { method: 'POST', url: 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', status: 200, json: init },
      { method: 'PUT', url: init.upload_url, status: 200, body: '' },
    ]);
    const url = await ADAPTERS.fal.upload(tempImage(t), ctxWith(fake.fetch));
    assert.equal(url, init.file_url);
    assert.equal(fake.calls[0].method, 'POST');
    assert.equal(fake.calls[0].url, 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3');
    assert.equal(fake.calls[1].method, 'PUT');
    assert.equal(fake.calls[1].url, init.upload_url);
    fake.assertClean();
  });
});

describe('WaveSpeed result states', () => {
  const RESULT = 'https://api.wavespeed.ai/api/v3/predictions/ws_task_001/result';
  const statusFor = async (name) => {
    const fake = createFakeFetch([{ method: 'GET', url: RESULT, status: 200, json: fixture('wavespeed', name) }]);
    return ADAPTERS.wavespeed.status('ws_task_001', ctxWith(fake.fetch), {});
  };

  test('cancelled is a cancelled job', async () => {
    const s = await statusFor('result-cancelled');
    assert.equal(s.state, 'cancelled');
    assert.deepEqual(s.outputs, []);
  });

  for (const name of ['timeout', 'deleted']) {
    test(`${name} is a failed job with a message (and not left "running")`, async () => {
      const s = await statusFor(`result-${name}`);
      assert.equal(s.state, 'failed');
      assert.equal(typeof s.error?.message, 'string');
      assert.ok(s.error.message.length > 0);
    });
  }

  test('processing is still running', async () => {
    assert.equal((await statusFor('result-processing')).state, 'running');
  });
});

describe('WaveSpeed live price', () => {
  const request = () => buildCanonicalRequest('seedance-2.0-mini', { prompt: PROMPT, res: '480p', duration: '5' },
    catalog, { cwd: process.cwd(), requirePrompt: true });
  const entry = () => supports(catalog, 'wavespeed', request()).entry;

  async function price(json) {
    let seen = null;
    const fake = createFakeFetch([{ method: 'POST', url: 'https://api.wavespeed.ai/api/v3/model/price',
      responses: [(req) => { seen = req; return { status: 200, json }; }] }]);
    const live = await ADAPTERS.wavespeed.livePrice(request(), ctxWith(fake.fetch), { entry: entry() });
    return { live, seen };
  }

  test('posts { model_id, input } (singular input, never inputs)', async () => {
    const { seen } = await price(fixture('wavespeed', 'price-live-discounted'));
    assert.equal(seen.body.model_id, 'bytedance/seedance-2.0-mini/text-to-video');
    assert.equal(typeof seen.body.input, 'object');
    assert.equal(seen.body.input.prompt, PROMPT);
    assert.equal(seen.body.input.duration, 5);
    assert.equal(seen.body.input.resolution, '480p');
    assert.ok(!('inputs' in seen.body), 'no "inputs" field');
  });

  test('uses data.discounted_price, the price the account pays', async () => {
    const { live } = await price(fixture('wavespeed', 'price-live-discounted'));
    assert.equal(live.usd, 0.27);
  });

  test('falls back to data.price when there is no discounted_price', async () => {
    const { live } = await price(fixture('wavespeed', 'price-live'));
    assert.equal(live.usd, 0.25);
  });
});

describe('Kie, from recorded responses', () => {
  const RECORD = 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_kie_001';

  test('upload returns the file URL from the response', async (t) => {
    const fake = createFakeFetch([
      { method: 'POST', url: 'https://kieai.redpandaai.co/api/file-stream-upload', status: 200, json: fixture('kie', 'upload') },
    ]);
    const url = await ADAPTERS.kie.upload(tempImage(t), ctxWith(fake.fetch));
    assert.equal(url, 'https://tempfile.redpandaai.co/kieai/1000/images/frame.png');
  });

  test('a finished job lists its result URL', async () => {
    const fake = createFakeFetch([{ method: 'GET', url: RECORD, status: 200, json: fixture('kie', 'status-success') }]);
    const s = await ADAPTERS.kie.status('task_kie_001', ctxWith(fake.fetch));
    assert.deepEqual(s, { state: 'succeeded', outputs: ['https://cdn.cheapgen-test.example/out/kie-1.mp4'] });
  });

  test('a job that failed on a bad first frame reports the reason and is not a provider fault', async () => {
    const fake = createFakeFetch([{ method: 'GET', url: RECORD, status: 200, json: fixture('kie', 'status-fail') }]);
    const s = await ADAPTERS.kie.status('task_kie_001', ctxWith(fake.fetch));
    assert.equal(s.state, 'failed');
    assert.equal(s.error.code, '400');
    assert.match(s.error.message, /at least 300px/);
    assert.equal(s.error.providerFault, false);
  });

  test('an unknown job (code 422 inside HTTP 200) is a read error, not a running job', async () => {
    const fake = createFakeFetch([{ method: 'GET', url: RECORD, status: 200, json: fixture('kie', 'status-unknown-job') }]);
    await assert.rejects(ADAPTERS.kie.status('task_kie_001', ctxWith(fake.fetch)), (err) => err.status === 422);
  });

  test('a model Kie does not know (code 422 inside HTTP 200) is a clear rejection', async () => {
    const fake = createFakeFetch([
      { method: 'POST', url: 'https://api.kie.ai/api/v1/jobs/createTask', status: 200, json: fixture('kie', 'create-unknown-model') },
    ]);
    const entry = catalog.models['seedance-2.0-mini'].providers.kie;
    const request = { kind: 'video', mode: 'text-to-video', prompt: PROMPT, resolution: '480p', duration: 4, aspectRatio: '16:9', audio: true };
    await assert.rejects(ADAPTERS.kie.submit(request, ctxWith(fake.fetch), { entry }),
      (err) => err.name === 'SubmitRejected' && err.code === 422);
  });
});

describe('Replicate upload', () => {
  test('the multipart form carries filename and type as well as content', async (t) => {
    let form = null;
    const fetch = async (url, init) => {
      assert.equal(url, 'https://api.replicate.com/v1/files');
      form = init.body;
      return new Response(JSON.stringify(fixture('replicate', 'file-upload')), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const url = await ADAPTERS.replicate.upload(tempImage(t, 'first-frame.png'), ctxWith(fetch));
    assert.equal(url, 'https://api.replicate.com/v1/files/file_001.png');
    assert.ok(form instanceof FormData, 'sent as multipart form data');
    assert.ok(form.get('content') instanceof Blob, 'content is the file');
    assert.equal(form.get('filename'), 'first-frame.png');
    assert.match(String(form.get('type')), /^[\w.+-]+\/[\w.+-]+$/, 'type is a MIME type');
  });
});
