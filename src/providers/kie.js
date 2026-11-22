// Kie adapter. API: https://docs.kie.ai
//
// Endpoint paths and field names follow Kie's docs.
import { http, describeBody } from '../http.js';
import { SubmitRejected, SubmitUnknown } from './errors.js';
import { postJob, getJson, readError, fileBlob, asRejection, videoFields, imageFields } from './common.js';
import { loadKiePriceList, kieUnitPrice, USD_PER_CREDIT } from './kie-price-list.js';
import { cost } from '../pricing/formulas.js';
import { pricedRequest } from '../request.js';

const BASE = 'https://api.kie.ai';
const UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';
export { USD_PER_CREDIT };

const auth = (ctx) => ({ Authorization: `Bearer ${ctx.key}` });

const STATES = { waiting: 'queued', queuing: 'queued', generating: 'running', success: 'succeeded', fail: 'failed' };

/**
 * What a finished job cost, or null. The field also reads 0 before the charge is known, so 0
 * counts only for a failed job.
 */
function chargeOf(state, credits) {
  const known = typeof credits === 'number' && Number.isFinite(credits)
    && ((state === 'succeeded' && credits > 0) || (state === 'failed' && credits >= 0));
  return known ? credits * USD_PER_CREDIT : null;
}

/** The address of an uploaded file: Kie answers { code, msg, data: { downloadUrl, ... } }. */
function uploadedUrl(body) {
  const url = body?.data?.downloadUrl;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

export default {
  id: 'kie',
  displayName: 'Kie',
  envVar: 'KIE_API_KEY',
  billing: { failedJobCharged: false, validationErrorMayCharge: false },

  buildRequest(r, { entry, imageUrl }) {
    const input = r.kind === 'image'
      ? { prompt: r.prompt, ...imageFields(r, entry, 'resolution') }
      : { prompt: r.prompt, ...videoFields(r, { entry }), ...(imageUrl ? { first_frame_url: imageUrl } : {}) };
    return { method: 'POST', url: `${BASE}/api/v1/jobs/createTask`, body: { model: entry.id, input } };
  },

  /** Price from Kie's public list, matched on the entry's `live.kieDescription`. */
  async livePrice(r, ctx, { bundled, frameSizes }) {
    const entry = bundled?.entry;
    const description = entry?.live?.kieDescription;
    if (!description) return null;
    const rows = await loadKiePriceList(ctx);
    const unitUsd = rows ? kieUnitPrice(rows, description, entry.pricing.type) : null;
    if (unitUsd === null) return null;
    return { usd: cost({ ...entry.pricing, usd: unitUsd }, pricedRequest(r), frameSizes), unit: entry.pricing.type };
  },

  async balance(ctx) {
    const res = await http(ctx, { url: `${BASE}/api/v1/chat/credit`, headers: auth(ctx), timeoutMs: 15_000 });
    const credits = res.ok && res.json?.code === 200 ? res.json.data : null;
    return typeof credits === 'number' ? credits * USD_PER_CREDIT : null;
  },

  async upload(filePath, ctx) {
    return asRejection('the image to Kie', async () => {
      const { blob, name } = fileBlob(filePath);
      const form = new FormData();
      form.append('file', blob, name);
      form.append('uploadPath', 'images');
      form.append('fileName', name);
      const res = await http(ctx, { method: 'POST', url: UPLOAD_URL, headers: auth(ctx), body: form, timeoutMs: 300_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${describeBody(res)}`);
      return uploadedUrl(res.json);
    });
  },

  async submit(r, ctx, { entry, imageUrl }) {
    const { url, body } = this.buildRequest(r, { entry, imageUrl });
    const res = await postJob(ctx, { url, headers: auth(ctx), json: body });
    const j = res.json;
    if (!j || typeof j.code !== 'number') throw new SubmitUnknown(`unexpected response: ${describeBody(res)}`);
    if (j.code === 200 && j.data?.taskId) return { nativeId: String(j.data.taskId) };
    if (j.code >= 500 || j.code === 200) throw new SubmitUnknown(`Kie code ${j.code}: ${describeBody(res)}`);
    throw new SubmitRejected(`Kie code ${j.code}: ${describeBody(res)}`, { code: j.code });
  },

  async status(nativeId, ctx) {
    const j = await getJson(ctx, `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(nativeId)}`, auth(ctx));
    if (j?.code !== 200 || !j.data) throw readError(`Kie code ${j?.code}: ${j?.msg ?? 'no task data'}`, j?.code);
    const d = j.data;
    const state = STATES[d.state] ?? 'running';
    let outputs = [];
    if (state === 'succeeded') {
      try { outputs = JSON.parse(d.resultJson || '{}').resultUrls ?? []; } catch { outputs = []; }
    }
    const error = state === 'failed'
      ? { code: d.failCode || null, message: d.failMsg || 'the job failed', providerFault: /^5/.test(String(d.failCode ?? '')) }
      : undefined;
    const actualUsd = chargeOf(state, d.creditsConsumed);
    return { state, outputs, ...(error ? { error } : {}), ...(actualUsd === null ? {} : { actualUsd }) };
  },
};
