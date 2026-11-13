// fal adapter. API: https://docs.fal.ai (queue API).
// fal doesn't charge for 5xx failures but may charge for 422 validation errors.
// The balance needs a key with billing:usage:read; without it the balance is unknown.
import { http, describeBody } from '../http.js';
import { SubmitUnknown } from './errors.js';
import { postJob, getJson, fileBlob, asRejection, videoFields } from './common.js';
import { cost } from '../pricing/formulas.js';
import { pricedRequest } from '../request.js';

const QUEUE = 'https://queue.fal.run';
const API = 'https://api.fal.ai/v1';
const STORAGE = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const auth = (ctx) => ({ Authorization: `Key ${ctx.key}` });

const endpointOf = (r, entry) => `${entry.id}/${entry.modes?.[r.mode] ?? r.mode}`;

/** fal's queue status URLs use the app id: the first two segments of the endpoint. */
const appIdOf = (endpoint) => endpoint.split('/').slice(0, 2).join('/');

/** Maps a unit price from fal's pricing API onto our bundled formula. */
function liveToPricing(unit, unitPrice, bundledPricing) {
  const u = String(unit ?? '').toLowerCase();
  if (/^(second|seconds|sec)$/.test(u)) return { type: 'perSecond', usd: unitPrice };
  if (/^(image|images)$/.test(u)) return { type: 'perImage', usd: unitPrice };
  if (/token/.test(u) && bundledPricing?.type === 'perToken') {
    const per1k = /1m|million/.test(u) ? unitPrice / 1000 : /1k|thousand/.test(u) ? unitPrice : null;
    return per1k === null ? null : { ...bundledPricing, usdPer1kTokens: per1k };
  }
  return null;
}

export default {
  id: 'fal',
  displayName: 'fal',
  envVar: 'FAL_KEY',
  billing: { failedJobCharged: false, validationErrorMayCharge: true },

  buildRequest(r, { entry, imageUrl }) {
    const body = r.kind === 'image'
      ? { prompt: r.prompt, aspect_ratio: r.aspectRatio, resolution: r.size }
      : { prompt: r.prompt, ...videoFields(r, { durationAsString: true }), ...(imageUrl ? { image_url: imageUrl } : {}) };
    return { method: 'POST', url: `${QUEUE}/${endpointOf(r, entry)}`, body };
  },

  async livePrice(r, ctx, { entry, bundled, frameSizes }) {
    const endpoint = endpointOf(r, entry);
    const res = await http(ctx, { url: `${API}/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`,
      headers: auth(ctx), timeoutMs: 10_000 });
    if (!res.ok) return null;
    const p = (res.json?.prices ?? []).find((x) => x.endpoint_id === endpoint) ?? res.json?.prices?.[0];
    if (!p || typeof p.unit_price !== 'number' || (p.currency && p.currency !== 'USD')) return null;
    const pricing = liveToPricing(p.unit, p.unit_price, bundled?.entry?.pricing);
    if (!pricing) return null;
    return { usd: cost(pricing, pricedRequest(r), frameSizes), unit: p.unit };
  },

  async balance(ctx) {
    const res = await http(ctx, { url: `${API}/account/billing?expand=credits`, headers: auth(ctx), timeoutMs: 15_000 });
    const balance = res.ok ? res.json?.credits?.current_balance : null;
    return typeof balance === 'number' ? balance : null;
  },

  async upload(filePath, ctx) {
    return asRejection('the image to fal', async () => {
      const { blob, name } = fileBlob(filePath);
      const init = await http(ctx, { method: 'POST', url: STORAGE, headers: auth(ctx), timeoutMs: 30_000,
        json: { content_type: 'application/octet-stream', file_name: name } });
      if (!init.ok || !init.json?.upload_url) throw new Error(`HTTP ${init.status}: ${describeBody(init)}`);
      const put = await http(ctx, { method: 'PUT', url: init.json.upload_url, body: blob, timeoutMs: 300_000,
        headers: { 'Content-Type': 'application/octet-stream' } });
      if (!put.ok) throw new Error(`HTTP ${put.status}: ${describeBody(put)}`);
      return init.json.file_url;
    });
  },

  async submit(r, ctx, { entry, imageUrl }) {
    const { url, body } = this.buildRequest(r, { entry, imageUrl });
    const res = await postJob(ctx, { url, headers: auth(ctx), json: body });
    const j = res.json;
    if (!j?.request_id) throw new SubmitUnknown(`no request id in the response: ${describeBody(res)}`);
    const endpoint = endpointOf(r, entry);
    const base = `${QUEUE}/${appIdOf(endpoint)}/requests/${j.request_id}`;
    return { nativeId: String(j.request_id),
      meta: { endpoint, statusUrl: j.status_url ?? `${base}/status`, responseUrl: j.response_url ?? base } };
  },

  async status(nativeId, ctx, meta) {
    if (!meta?.statusUrl && !meta?.endpoint) {
      throw new Error('fal job details are not in the spend log, so its status URL is unknown');
    }
    const base = `${QUEUE}/${appIdOf(meta.endpoint ?? '')}/requests/${encodeURIComponent(nativeId)}`;
    const statusUrl = meta.statusUrl ?? `${base}/status`;
    const responseUrl = meta.responseUrl ?? base;
    const s = await getJson(ctx, statusUrl, auth(ctx));
    if (s?.status === 'IN_QUEUE') return { state: 'queued', outputs: [] };
    if (s?.status !== 'COMPLETED') return { state: 'running', outputs: [] };
    const res = await http(ctx, { url: responseUrl, headers: auth(ctx), timeoutMs: 30_000 });
    if (!res.ok) {
      return { state: 'failed', outputs: [], error: { code: String(res.status), message: describeBody(res), providerFault: res.status >= 500 } };
    }
    const j = res.json ?? {};
    const outputs = [j.video?.url, j.image?.url, ...(j.images ?? []).map((i) => i?.url), ...(j.videos ?? []).map((v) => v?.url)]
      .filter((u) => typeof u === 'string');
    return { state: 'succeeded', outputs };
  },
};
