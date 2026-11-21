// Fake of Kie's public price list: POST /client/v1/model-pricing/page, paged.
// The page envelope comes from test/fixtures/kie/price-list-page.json (synthetic); rows are
// in `data.records`, with prices as strings.
import { fixture, routesFor } from './providers.js';

export const LIST_URL = 'https://api.kie.ai/client/v1/model-pricing/page';
export const DESC = {
  mini480: 'bytedance/seedance-2-mini, 480P no video',
  mini720: 'bytedance/seedance-2-mini, 720P no video',
  pro1k: 'seedream 5 Pro, text-to-image, 1K',
};

/** One list row. Pass `usd: null` to omit usdPrice (then only creditPrice is known). */
export function row(modelDescription, { usd, credit, unit = 'per second' }) {
  const template = fixture('kie', 'price-list-page').data.records[0];
  const r = { ...template, modelDescription, creditUnit: unit,
    creditPrice: String(credit ?? (usd / 0.005)) };
  if (usd === null || usd === undefined) delete r.usdPrice; else r.usdPrice = String(usd);
  return r;
}

/** Rows that match nothing the tests ask for; used to make the list span several pages. */
export const filler = (n) => Array.from({ length: n }, (_, i) =>
  row(`other/model-${i}, 720P no video`, { usd: 0.5 + i / 1000, unit: 'per second' }));

/**
 * Route answering the list, `pageSize` rows per page. `failPage` makes that page answer 503.
 * `pages` is the number of pages the server reports.
 */
export function listRoute(rows, { pageSize = 100, failPage = null } = {}) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const respond = (req) => {
    const pageNum = Number(req.body?.pageNum ?? 1);
    if (pageNum === failPage) return { status: 503, json: { code: 503, msg: 'unavailable' } };
    const envelope = fixture('kie', 'price-list-page');
    envelope.data = { ...envelope.data, records: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize),
      total: rows.length, size: pageSize, current: pageNum, pages };
    return { status: 200, json: envelope };
  };
  return { method: 'POST', url: LIST_URL, responses: [respond] };
}

/** Kie routes (balance, status, ...) plus a list answering with `rows`, or a raw response. */
export function kieRoutes(rows, opts = {}) {
  const others = routesFor('kie').filter((r) => r.url !== LIST_URL);
  const list = Array.isArray(rows) ? listRoute(rows, opts) : { method: 'POST', url: LIST_URL, ...rows };
  return [...others, list];
}

export const listCalls = (calls) => calls.filter((c) => c.url === LIST_URL);
