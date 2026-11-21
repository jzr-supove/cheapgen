// fal adapter. API: https://docs.fal.ai (queue API).
// fal doesn't charge for 5xx failures but may charge for 422 validation errors.
// The balance needs a key with billing:usage:read; without it the balance is unknown.
import { http, describeBody } from '../http.js';
import { SubmitUnknown } from './errors.js';
import { postJob, getJson, fileBlob, asRejection, videoFields, imageFields, endpointPath } from './common.js';
import { cost } from '../pricing/formulas.js';
import { pricedRequest } from '../request.js';

const QUEUE = 'https://queue.fal.run';
const API = 'https://api.fal.ai/v1';
const MAX_ENDPOINTS = 50; // per pricing request
const STORAGE = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const auth = (ctx) => ({ Authorization: `Key ${ctx.key}` });

const endpointOf = endpointPath;

/** fal's queue status URLs use the app id: the first two segments of the endpoint. */
const appIdOf = (endpoint) => endpoint.split('/').slice(0, 2).join('/');

/**
 * fal's API gives one base price per endpoint. Sizes and resolutions billed at a higher rate are
 * marked `live.falUnitPrice: false` in the price data, and use the bundled price.
 */
export const hasLivePrice = (priceEntry) => priceEntry?.live?.falUnitPrice !== false;

/** Maps a unit price from fal's pricing API onto our bundled formula. */
export function liveToPricing(unit, unitPrice, bundledPricing) {
  const u = String(unit ?? '').toLowerCase();
  if (/^(second|seconds|sec)$/.test(u)) return { type: 'perSecond', usd: unitPrice };
  if (/^(image|images)$/.test(u)) return { type: 'perImage', usd: unitPrice };
  if (/token/.test(u) && bundledPricing?.type === 'perToken') {
    // fal's units look like "1000 tokens" or "1m tokens" (fal.ai/pricing.md).
    const per1k = /\b(1m|1 ?million|1,?000,?000)\b/.test(u) ? unitPrice / 1000
      : /\b(1k|1,?000|thousand)\b/.test(u) ? unitPrice : null;
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
      ? { prompt: r.prompt, ...imageFields(r, entry, 'resolution') }
      : { prompt: r.prompt, ...videoFields(r, { durationAsString: true, entry }), ...(imageUrl ? { image_url: imageUrl } : {}) };
    return { method: 'POST', url: `${QUEUE}/${endpointOf(r, entry)}`, body };
  },

  /**
   * fal's base unit prices: a Map of endpoint to `{ unit, unitPrice }`. Endpoints without a usable
   * price are left out. fal allows only about two of these requests a minute, so ask for all the
   * endpoints at once and don't retry.
   */
  async unitPrices(endpoints, ctx) {
    const prices = new Map();
    const wanted = [...new Set(endpoints)];
    for (let i = 0; i < wanted.length; i += MAX_ENDPOINTS) {
      const query = wanted.slice(i, i + MAX_ENDPOINTS).map((e) => `endpoint_id=${encodeURIComponent(e)}`).join('&');
      const res = await http(ctx, { url: `${API}/models/pricing?${query}`, headers: auth(ctx), timeoutMs: 10_000, retries: 0 });
      for (const p of (res.ok && res.json?.prices) || []) {
        if (typeof p?.unit_price === 'number' && (!p.currency || p.currency === 'USD')) {
          prices.set(p.endpoint_id, { unit: p.unit, unitPrice: p.unit_price });
        }
      }
    }
    return prices;
  },

  async livePrice(r, ctx, { entry, bundled, frameSizes }) {
    if (!hasLivePrice(bundled?.entry)) return null;
    const endpoint = endpointOf(r, entry);
    const p = (await this.unitPrices([endpoint], ctx)).get(endpoint);
    if (!p) return null;
    const pricing = liveToPricing(p.unit, p.unitPrice, bundled?.entry?.pricing);
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
      const { blob, name, type } = fileBlob(filePath);
      const init = await http(ctx, { method: 'POST', url: STORAGE, headers: auth(ctx), timeoutMs: 30_000,
        json: { content_type: type, file_name: name } });
      if (!init.ok || !init.json?.upload_url) throw new Error(`HTTP ${init.status}: ${describeBody(init)}`);
      const put = await http(ctx, { method: 'PUT', url: init.json.upload_url, body: blob, timeoutMs: 300_000,
        headers: { 'Content-Type': type } });
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
    // A failed or cancelled request also reports COMPLETED, with an error field.
    if (s.error) {
      return { state: 'failed', outputs: [], error: { code: s.error_type ?? null, message: String(s.error), providerFault: false } };
    }
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
