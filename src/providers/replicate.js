// Replicate adapter. API: https://replicate.com/docs/reference/http
// Replicate has no balance or price API.
import { http, describeBody } from '../http.js';
import { SubmitUnknown } from './errors.js';
import { postJob, getJson, fileBlob, asRejection, videoFields, imageFields } from './common.js';

const BASE = 'https://api.replicate.com/v1';
const auth = (ctx) => ({ Authorization: `Bearer ${ctx.key}` });

const STATES = { starting: 'queued', processing: 'running', succeeded: 'succeeded', failed: 'failed', canceled: 'cancelled' };

export default {
  id: 'replicate',
  displayName: 'Replicate',
  envVar: 'REPLICATE_API_TOKEN',
  // failedJobFree: Replicate reports no charges, but never bills a failed run of these models
  // (a cancelled one may be billed), so `spend` counts it as $0.
  billing: { failedJobCharged: false, validationErrorMayCharge: false, failedJobFree: true },

  buildRequest(r, { entry, imageUrl }) {
    const input = r.kind === 'image'
      ? { prompt: r.prompt, ...imageFields(r, entry, 'size') }
      : { prompt: r.prompt, ...videoFields(r, { entry }), ...(imageUrl ? { image: imageUrl } : {}) };
    return { method: 'POST', url: `${BASE}/models/${entry.id}/predictions`, body: { input } };
  },

  async balance() {
    return null;
  },

  async upload(filePath, ctx) {
    return asRejection('the image to Replicate', async () => {
      const { blob, name, type } = fileBlob(filePath);
      const form = new FormData();
      form.append('content', blob, name);
      form.append('filename', name);
      form.append('type', type);
      const res = await http(ctx, { method: 'POST', url: `${BASE}/files`, headers: auth(ctx), body: form, timeoutMs: 300_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${describeBody(res)}`);
      return res.json?.urls?.get;
    });
  },

  async submit(r, ctx, { entry, imageUrl }) {
    const { url, body } = this.buildRequest(r, { entry, imageUrl });
    const res = await postJob(ctx, { url, headers: auth(ctx), json: body });
    if (!res.json?.id) throw new SubmitUnknown(`no prediction id in the response: ${describeBody(res)}`);
    return { nativeId: String(res.json.id) };
  },

  async status(nativeId, ctx) {
    const j = await getJson(ctx, `${BASE}/predictions/${encodeURIComponent(nativeId)}`, auth(ctx));
    const state = STATES[j?.status] ?? 'running';
    const out = j?.output;
    const outputs = state === 'succeeded' ? (Array.isArray(out) ? out : out ? [out] : []).filter((u) => typeof u === 'string') : [];
    const error = state === 'failed' || state === 'cancelled'
      ? { code: null, message: typeof j.error === 'string' ? j.error : state === 'cancelled' ? 'the job was cancelled' : 'the job failed',
          providerFault: false }
      : undefined;
    return { state, outputs, ...(error ? { error } : {}) };
  },
};
