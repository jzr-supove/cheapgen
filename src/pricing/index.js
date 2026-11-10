// Prices one request on one provider: live price if the provider has a price
// API and a key, else a cached live price younger than 24 hours, else the bundled table.
import { cost } from './formulas.js';
import { pricedRequest } from '../request.js';

export const STALE_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = (d) => d.toISOString().slice(0, 10);

export function ageInDays(verifiedOn, now) {
  return Math.floor((now.getTime() - Date.parse(`${verifiedOn}T00:00:00Z`)) / DAY_MS);
}

function whenMatches(when, request) {
  return Object.entries(when ?? {}).every(([k, v]) =>
    (Array.isArray(v) ? v.includes(request[k]) : request[k] === v));
}

/** The most specific prices.json entry for this provider and request, or null. */
export function matchEntry(entries, providerId, request) {
  let best = null;
  let bestScore = -1;
  for (const e of entries) {
    if (e.provider !== providerId || e.model !== request.model) continue;
    if (e.mode !== '*' && e.mode !== request.mode) continue;
    if (!whenMatches(e.when, request)) continue;
    const score = Object.keys(e.when ?? {}).length * 2 + (e.mode === '*' ? 0 : 1);
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}

/** @returns {{ usd: number|null, source: 'bundled', verifiedOn?: string, ageDays?: number, entry?: object, reason?: string }} */
export function bundledPrice(catalog, providerId, request, now) {
  const entry = matchEntry(catalog.prices.entries, providerId, request);
  if (!entry) return { usd: null, source: null, reason: 'no price on record for this request' };
  let usd;
  try {
    usd = cost(entry.pricing, pricedRequest(request), catalog.frameSizes);
  } catch (err) {
    return { usd: null, source: null, reason: err.message };
  }
  return { usd, source: 'bundled', verifiedOn: entry.verifiedOn, ageDays: ageInDays(entry.verifiedOn, now), entry, sourceUrl: entry.sourceUrl };
}

export function cacheKey(providerId, r) {
  return [providerId, r.model, r.mode, r.resolution ?? r.size, r.aspectRatio,
    r.autoDuration ? 'auto' : r.duration, r.audio, r.count, r.image ? 'img' : ''].join('|');
}

/**
 * @param {object} p
 * @param {object} p.adapter
 * @param {object} p.request
 * @param {object} p.catalog
 * @param {object|null} p.ctx    adapter context with a key; null means "no live lookup"
 * @param {object} p.cache
 * @param {Date} p.now
 */
export async function priceFor({ adapter, request, catalog, ctx, cache, now }) {
  const bundled = bundledPrice(catalog, adapter.id, request, now);
  const result = (fields) => ({ provider: adapter.id, notes: [], ...fields });

  if (ctx && adapter.livePrice) {
    const key = cacheKey(adapter.id, request);
    let live = null;
    try {
      live = await adapter.livePrice(request, ctx, { entry: catalog.models[request.model].providers[adapter.id],
        bundled, frameSizes: catalog.frameSizes });
    } catch { live = null; }
    if (live && typeof live.usd === 'number' && Number.isFinite(live.usd)) {
      cache.set(key, live.usd, now);
      return result({ usd: live.usd, source: 'live', verifiedOn: isoDate(now), ageDays: 0 });
    }
    const hit = cache.get(key, now);
    if (hit) {
      return result({ usd: hit.usd, source: 'cache', verifiedOn: hit.at.slice(0, 10), ageDays: ageInDays(hit.at.slice(0, 10), now) });
    }
  }
  if (bundled.usd === null) return result({ usd: null, source: null, verifiedOn: null, reason: bundled.reason });
  return result({ usd: bundled.usd, source: 'bundled', verifiedOn: bundled.verifiedOn, ageDays: bundled.ageDays });
}

/** Warnings for bundled prices older than 14 days. */
export function staleWarnings(quotes) {
  const byDate = new Map();
  for (const q of quotes) {
    if (q.source === 'bundled' && q.ageDays > STALE_AFTER_DAYS) {
      if (!byDate.has(q.verifiedOn)) byDate.set(q.verifiedOn, { age: q.ageDays, providers: [] });
      byDate.get(q.verifiedOn).providers.push(q.provider);
    }
  }
  return [...byDate].map(([date, { age, providers }]) =>
    `bundled prices for ${providers.join(', ')} were last verified on ${date} (${age} days ago) and may be out of date; `
    + 'run `cheapgen prices --check`');
}
