// `prices --check`: compares each bundled price with its live source. It never
// needs a key and never names the environment variable that would supply one.
import { ADAPTERS } from '../providers/index.js';
import { endpointPath } from '../providers/common.js';
import { loadKiePriceList, kieUnitPrice } from '../providers/kie-price-list.js';
import { liveToPricing } from '../providers/fal.js';
import { buildCanonicalRequest, DEFAULTS } from '../request.js';

export const SAME_WITHIN = 0.005;
const STATUSES = ['same', 'changed', 'missing', 'unavailable', 'unchecked'];

const UNIT = { perSecond: 'second', perImage: 'image', perToken: '1k tokens' };

/** The entry's unit price (per second, per image or per 1k tokens), or null for other types. */
export function unitPriceOf(pricing) {
  if (pricing.type === 'perSecond' || pricing.type === 'perImage') return pricing.usd;
  if (pricing.type === 'perToken') return pricing.usdPer1kTokens;
  return null;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** A canonical request for the entry: its `when`, the tool's defaults for the rest. */
function requestFor(catalog, e, cwd) {
  const model = catalog.models[e.model];
  const flags = { prompt: 'price check' };
  if (model.kind === 'video') {
    flags.res = first(e.when?.resolution) ?? (model.resolutions.includes(DEFAULTS.resolution) ? DEFAULTS.resolution : model.resolutions[0]);
    if (e.mode === 'image-to-video') flags.image = 'https://example.com/first-frame.png';
  } else if (e.when?.size) {
    flags.size = first(e.when.size);
  }
  if (!model.aspectRatios.includes(DEFAULTS.aspectRatio)) flags.aspect = model.aspectRatios[0];
  return buildCanonicalRequest(e.model, flags, catalog, { cwd, requirePrompt: false });
}

/**
 * @param {object} app      the CLI app object
 * @param {object[]} entries prices.json entries to check
 * @returns {Promise<object[]>} one result per entry
 */
export async function checkPrices(app, entries) {
  const { io } = app;
  const base = { fetch: io.fetch, now: io.now, sleep: io.sleep, homedir: io.homedir, memo: app.liveMemo };
  const results = [];
  for (const e of entries) {
    const bundledUsd = unitPriceOf(e.pricing);
    const out = (status, fields = {}) => ({ provider: e.provider, model: e.model, mode: e.mode, when: e.when,
      bundledUsd, liveUsd: null, unit: UNIT[e.pricing.type] ?? e.pricing.type, status, reason: null, ...fields });
    const compare = (liveUsd) => {
      if (typeof liveUsd !== 'number' || !Number.isFinite(liveUsd)) return out('unavailable', { reason: 'no usable price in the answer' });
      const same = Math.abs(liveUsd - bundledUsd) <= SAME_WITHIN * Math.abs(bundledUsd);
      return out(same ? 'same' : 'changed', { liveUsd });
    };
    if (bundledUsd === null) {
      results.push(out('unchecked', { reason: `a ${e.pricing.type} price can't be compared with a unit price` }));
      continue;
    }
    try {
      results.push(await checkOne(app, e, base, out, compare));
    } catch {
      results.push(out('unavailable', { reason: 'the live source didn\'t answer' }));
    }
  }
  return results;
}

async function checkOne(app, e, base, out, compare) {
  if (e.provider === 'kie') {
    const description = e.live?.kieDescription;
    if (!description) return out('unchecked', { reason: 'no Kie price-list row on record' });
    const rows = await loadKiePriceList(base);
    if (!rows) return out('unavailable', { reason: 'Kie\'s price list didn\'t answer' });
    const live = kieUnitPrice(rows, description, e.pricing.type);
    return live === null ? out('missing', { reason: `no "${description}" row with a matching unit` }) : compare(live);
  }
  if (e.provider === 'replicate') return out('unchecked', { reason: 'no price API' });

  const key = app.keys[e.provider];
  if (!key) return out('unchecked', { reason: 'needs a key' });
  const ctx = { ...base, key };
  const request = requestFor(app.catalog, e, app.io.cwd);
  const entry = app.catalog.models[e.model].providers[e.provider];
  if (!entry) return out('unchecked', { reason: `${e.provider} doesn't list ${e.model}` });

  if (e.provider === 'wavespeed') {
    const live = await ADAPTERS.wavespeed.livePrice(request, ctx, { entry });
    if (!live) return out('unavailable', { reason: 'WaveSpeed\'s price API didn\'t answer' });
    if (e.pricing.type === 'perSecond') return compare(live.usd / request.duration);
    if (e.pricing.type === 'perImage') return compare(live.usd / request.count);
    return out('unchecked', { reason: `a ${e.pricing.type} price can't be compared with WaveSpeed's request price` });
  }

  if (e.provider === 'fal') {
    const p = await ADAPTERS.fal.unitPrice(endpointPath(request, entry), ctx);
    if (!p) return out('unavailable', { reason: 'fal\'s pricing API didn\'t answer' });
    const pricing = liveToPricing(p.unit, p.unitPrice, e.pricing);
    if (!pricing || pricing.type !== e.pricing.type) {
      return out('unchecked', { reason: `fal prices this per ${p.unit}, which doesn't match a ${e.pricing.type} price` });
    }
    return compare(unitPriceOf(pricing));
  }
  return out('unchecked', { reason: 'no price API' });
}

export function summarize(results) {
  const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of results) summary[r.status] += 1;
  return summary;
}
