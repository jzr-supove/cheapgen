// WaveSpeed adapter. API: https://wavespeed.ai/docs
// WaveSpeed refunds jobs that fail on its side, and has balance and price APIs.
import { http, describeBody } from '../http.js';
import { SubmitRejected, SubmitUnknown } from './errors.js';
import { postJob, getJson, fileBlob, asRejection, videoFields } from './common.js';
import { pricedRequest } from '../request.js';

const BASE = 'https://api.wavespeed.ai/api/v3';
const auth = (ctx) => ({ Authorization: `Bearer ${ctx.key}` });

const STATES = { created: 'queued', pending: 'queued', processing: 'running', completed: 'succeeded', failed: 'failed' };

const modelPath = (r, entry) => `${entry.id}/${entry.modes?.[r.mode] ?? r.mode}`;

function body(r, imageUrl) {
  return r.kind === 'image'
    ? { prompt: r.prompt, aspect_ratio: r.aspectRatio, size: r.size }
    : { prompt: r.prompt, ...videoFields(r), ...(imageUrl ? { image: imageUrl } : {}) };
}

export default {
  id: 'wavespeed',
  displayName: 'WaveSpeed',
  envVar: 'WAVESPEED_API_KEY',
  billing: { failedJobCharged: false, validationErrorMayCharge: false },

  buildRequest(r, { entry, imageUrl }) {
    return { method: 'POST', url: `${BASE}/${modelPath(r, entry)}`, body: body(r, imageUrl) };
  },

  async livePrice(r, ctx, { entry }) {
    const priced = pricedRequest(r);
    const res = await http(ctx, { method: 'POST', url: `${BASE}/model/price`, headers: auth(ctx), timeoutMs: 10_000,
      json: { model_id: modelPath(priced, entry), inputs: body(priced) } });
    const price = res.ok && res.json?.code === 200 ? res.json.data?.price : null;
    return typeof price === 'number' ? { usd: price, unit: 'request' } : null;
  },

  async balance(ctx) {
    const res = await http(ctx, { url: `${BASE}/balance`, headers: auth(ctx), timeoutMs: 15_000 });
    const balance = res.ok && res.json?.code === 200 ? res.json.data?.balance : null;
    return typeof balance === 'number' ? balance : null;
  },

  async upload(filePath, ctx) {
    return asRejection('the image to WaveSpeed', async () => {
      const { blob, name } = fileBlob(filePath);
      const form = new FormData();
      form.append('file', blob, name);
      const res = await http(ctx, { method: 'POST', url: `${BASE}/media/upload/binary`, headers: auth(ctx), body: form, timeoutMs: 300_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${describeBody(res)}`);
      return res.json?.data?.download_url;
    });
  },

  async submit(r, ctx, { entry, imageUrl }) {
    const { url, body: json } = this.buildRequest(r, { entry, imageUrl });
    // Insufficient credits is code 1407, with HTTP 400 (rejected by postJob) or inside a 200 envelope.
    const res = await postJob(ctx, { url, headers: auth(ctx), json });
    const j = res.json;
    if (!j || typeof j.code !== 'number') throw new SubmitUnknown(`unexpected response: ${describeBody(res)}`);
    if (j.code === 200 && j.data?.id) return { nativeId: String(j.data.id) };
    if (j.code === 200 || (j.code >= 500 && j.code < 600)) throw new SubmitUnknown(`WaveSpeed code ${j.code}: ${describeBody(res)}`);
    throw new SubmitRejected(`WaveSpeed code ${j.code}: ${describeBody(res)}`, { code: j.code });
  },

  async status(nativeId, ctx) {
    const j = await getJson(ctx, `${BASE}/predictions/${encodeURIComponent(nativeId)}/result`, auth(ctx));
    const d = j?.data ?? {};
    const state = STATES[d.status] ?? 'running';
    const outputs = state === 'succeeded' ? (d.outputs ?? []).filter((u) => typeof u === 'string') : [];
    const error = state === 'failed' ? { code: null, message: d.error || 'the job failed', providerFault: false } : undefined;
    return { state, outputs, ...(error ? { error } : {}) };
  },
};
