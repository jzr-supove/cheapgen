// Kie's public price list. No key is needed. The whole list is read page by page,
// cached on disk for 24 hours, and read at most once per command.
import fs from 'node:fs';
import path from 'node:path';
import { http } from '../http.js';

export const KIE_PRICE_LIST_URL = 'https://api.kie.ai/client/v1/model-pricing/page';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 50;
const MEMO_KEY = 'kie-price-list';
/** Kie sells credits at $0.005 each. */
export const USD_PER_CREDIT = 0.005;

const cacheFile = (homedir) => path.join(homedir, '.cheapgen', 'cache', 'kie-price-list.json');

/**
 * @param {{ fetch, sleep, now, homedir?, memo?: Map }} ctx
 * @returns {Promise<object[] | null>} rows, or null when the list couldn't be read
 */
export function loadKiePriceList(ctx) {
  if (ctx.memo?.has(MEMO_KEY)) return ctx.memo.get(MEMO_KEY);
  const pending = readList(ctx);
  ctx.memo?.set(MEMO_KEY, pending);
  return pending;
}

async function readList(ctx) {
  const now = ctx.now();
  const file = ctx.homedir ? cacheFile(ctx.homedir) : null;
  if (file) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      const age = now.getTime() - Date.parse(cached.fetchedAt);
      if (Array.isArray(cached.rows) && age >= 0 && age < TTL_MS) return cached.rows;
    } catch { /* no usable cache */ }
  }

  const rows = [];
  try {
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
      const res = await http(ctx, { method: 'POST', url: KIE_PRICE_LIST_URL, timeoutMs: 15_000,
        json: { pageNum, pageSize: 100, modelDescription: '', interfaceType: '' } });
      const data = res.ok && res.json?.code === 200 ? res.json.data : null;
      if (!data || !Array.isArray(data.records)) return null;
      for (const r of data.records) {
        rows.push({ modelDescription: r.modelDescription, creditPrice: r.creditPrice, creditUnit: r.creditUnit,
          usdPrice: r.usdPrice });
      }
      if (!(Number(data.current) < Number(data.pages))) break;
    }
  } catch {
    return null;
  }

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: now.toISOString(), rows }));
    } catch { /* a cache that can't be written is just a slower cache */ }
  }
  return rows;
}

const UNIT_FOR_TYPE = { perSecond: 'per second', perImage: 'per image' };

/**
 * The unit price of the row named `description`, if its unit fits the pricing type.
 * @returns {number | null} null when the row is missing or its unit doesn't match
 */
export function kieUnitPrice(rows, description, pricingType) {
  const row = rows.find((r) => r.modelDescription === description);
  if (!row || String(row.creditUnit ?? '').trim().toLowerCase() !== UNIT_FOR_TYPE[pricingType]) return null;
  const usd = row.usdPrice !== undefined && row.usdPrice !== null && row.usdPrice !== ''
    ? Number(row.usdPrice) : Number(row.creditPrice) * USD_PER_CREDIT;
  return Number.isFinite(usd) ? usd : null;
}
