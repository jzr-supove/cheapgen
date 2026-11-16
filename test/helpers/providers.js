// Route tables for the fake fetch, one builder per provider. This is the ONE place that
// encodes assumptions about provider URLs and response shapes (built from the providers'
// public docs, not from recorded responses). When a real recorded response proves an
// assumption wrong, fix it here and in test/fixtures/<provider>/*.json.
//
// Every builder returns a list of routes. A provider that is not connected in a test simply
// gets no routes, so any call to it fails the test.
//
// Options (all providers):
//   balance: 'ok' | 'low' | 'forbidden' (fal only) | 'none' (no balance route)
//   submit:  outcome name (below), or a raw response / (req) => response
//   states:  names of status fixtures returned in order by the status endpoint; last repeats
//   live:    'down' (live price lookup answers 503, so bundled prices are used) or a raw response
//
// Submit outcome names: success, insufficient, insufficient-envelope, unauthorized,
// rate-limited, server-error, bad-gateway, network-error, timeout.
import { readFileSync } from 'node:fs';

export const fixture = (provider, name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${provider}/${name}.json`, import.meta.url), 'utf8'));

export const CDN = 'https://cdn.cheapgen-test.example/out/';
export const FAKE_MEDIA_BYTES = 'FAKE-VIDEO-BYTES';

export const HOSTS = {
  kie: ['api.kie.ai'],
  replicate: ['api.replicate.com'],
  wavespeed: ['api.wavespeed.ai'],
  fal: ['queue.fal.run', 'api.fal.ai', 'rest.alpha.fal.ai'],
};

const down = { status: 503, json: { error: 'live price lookup unavailable' } };
const livePrice = (live) => (live === undefined || live === 'down' ? down : live);

const ERR = {
  'network-error': () => ({ error: new TypeError('fetch failed') }),
  timeout: () => ({ timeout: true }),
  'bad-gateway': () => ({ status: 502, body: 'Bad Gateway', headers: { 'content-type': 'text/plain' } }),
};
const resolve = (table, outcome) => {
  if (typeof outcome !== 'string') return outcome;
  const make = ERR[outcome] ?? table[outcome];
  if (!make) throw new Error(`unknown submit outcome: ${outcome}`);
  return make();
};

const submitRoute = (method, url, table, outcome) => {
  const r = resolve(table, outcome);
  return typeof r === 'function' ? { method, url, responses: [r] } : { method, url, ...r };
};

export function kie({ balance = 'ok', submit = 'success', states = ['success'], live } = {}) {
  const outcomes = {
    success: () => ({ status: 200, json: fixture('kie', 'create-success') }),
    insufficient: () => ({ status: 200, json: fixture('kie', 'create-insufficient-credits') }),
    'insufficient-http': () => ({ status: 402, json: fixture('kie', 'create-insufficient-credits') }),
    unauthorized: () => ({ status: 401, json: fixture('kie', 'create-unauthorized') }),
    'unauthorized-envelope': () => ({ status: 200, json: fixture('kie', 'create-unauthorized') }),
    'rate-limited': () => ({ status: 429, json: fixture('kie', 'create-rate-limited') }),
    'server-error': () => ({ status: 500, json: fixture('kie', 'create-server-error') }),
  };
  const routes = [
    submitRoute('POST', 'https://api.kie.ai/api/v1/jobs/createTask', outcomes, submit),
    { method: 'GET', url: 'https://api.kie.ai/api/v1/jobs/recordInfo',
      responses: states.map((s) => ({ status: 200, json: fixture('kie', `status-${s}`) })) },
    { method: 'POST', url: 'https://api.kie.ai/client/v1/model-pricing/page', ...livePrice(live) },
  ];
  if (balance !== 'none') {
    routes.push({ method: 'GET', url: 'https://api.kie.ai/api/v1/chat/credit',
      status: 200, json: fixture('kie', balance === 'low' ? 'balance-low' : 'balance') });
  }
  return routes;
}

export function replicate({ submit = 'success', states = ['succeeded'], live } = {}) {
  const outcomes = {
    success: () => ({ status: 201, json: fixture('replicate', 'create-success') }),
    insufficient: () => ({ status: 402, json: fixture('replicate', 'create-insufficient-credit') }),
    'rate-limited': () => ({ status: 429, json: fixture('replicate', 'create-rate-limited') }),
    unauthorized: () => ({ status: 401, json: fixture('replicate', 'create-unauthorized') }),
    'server-error': () => ({ status: 500, json: { title: 'Internal Server Error', status: 500 } }),
  };
  void live; // Replicate has no price API
  return [
    submitRoute('POST', /^https:\/\/api\.replicate\.com\/v1\/(models\/[^/]+\/[^/]+\/)?predictions$/, outcomes, submit),
    { method: 'GET', url: /^https:\/\/api\.replicate\.com\/v1\/predictions\/[^/?]+$/,
      responses: states.map((s) => ({ status: 200, json: fixture('replicate', `prediction-${s}`) })) },
  ];
}

export function wavespeed({ balance = 'ok', submit = 'success', states = ['completed'], live } = {}) {
  const outcomes = {
    success: () => ({ status: 200, json: fixture('wavespeed', 'submit-success') }),
    insufficient: () => ({ status: 400, json: fixture('wavespeed', 'submit-insufficient-credits') }),
    'insufficient-envelope': () => ({ status: 200, json: fixture('wavespeed', 'submit-insufficient-credits') }),
    'rate-limited': () => ({ status: 429, json: { code: 429, message: 'Too many requests' } }),
    unauthorized: () => ({ status: 401, json: { code: 401, message: 'Invalid API key' } }),
    'server-error': () => ({ status: 500, json: { code: 500, message: 'Internal Server Error' } }),
  };
  const routes = [
    submitRoute('POST', /^https:\/\/api\.wavespeed\.ai\/api\/v3\/(?!balance|model\/price|predictions)[^?]+$/, outcomes, submit),
    { method: 'GET', url: /^https:\/\/api\.wavespeed\.ai\/api\/v3\/predictions\/[^/?]+\/result$/,
      responses: states.map((s) => ({ status: 200, json: fixture('wavespeed', `result-${s}`) })) },
    { method: 'POST', url: 'https://api.wavespeed.ai/api/v3/model/price', ...livePrice(live) },
  ];
  if (balance !== 'none') {
    routes.push({ method: 'GET', url: 'https://api.wavespeed.ai/api/v3/balance',
      status: 200, json: fixture('wavespeed', balance === 'low' ? 'balance-low' : 'balance') });
  }
  return routes;
}

export function fal({ balance = 'ok', submit = 'success', states = ['completed'], live } = {}) {
  const outcomes = {
    success: () => ({ status: 200, json: fixture('fal', 'submit-success') }),
    insufficient: () => ({ status: 403, json: { detail: 'User is locked. Reason: Exhausted balance.' } }),
    'rate-limited': () => ({ status: 429, json: { detail: 'Too many requests' } }),
    unauthorized: () => ({ status: 401, json: fixture('fal', 'submit-unauthorized') }),
    'server-error': () => ({ status: 500, json: { detail: 'Internal Server Error' } }),
  };
  const routes = [
    submitRoute('POST', /^https:\/\/queue\.fal\.run\//, outcomes, submit),
    { method: 'GET', url: /^https:\/\/queue\.fal\.run\/.+\/requests\/[^/?]+\/status/,
      responses: states.map((s) => ({ status: 200, json: fixture('fal', `status-${s}`) })) },
    { method: 'GET', url: /^https:\/\/queue\.fal\.run\/.+\/requests\/[^/?]+$/,
      status: 200, json: fixture('fal', 'result') },
    { method: 'GET', url: /^https:\/\/api\.fal\.ai\/v1\/models\/pricing/, ...livePrice(live) },
  ];
  if (balance !== 'none') {
    routes.push({ method: 'GET', url: /^https:\/\/api\.fal\.ai\/v1\/account\/billing/,
      ...(balance === 'forbidden'
        ? { status: 403, json: fixture('fal', 'balance-forbidden') }
        : { status: 200, json: fixture('fal', 'balance') }) });
  }
  return routes;
}

/** Downloads of result files from the (fake) CDN. */
export function cdn() {
  return [{ method: 'GET', url: /^https:\/\/cdn\.cheapgen-test\.example\//, status: 200,
    body: FAKE_MEDIA_BYTES, headers: { 'content-type': 'video/mp4' } }];
}

const BUILDERS = { kie, replicate, wavespeed, fal };

/** routesFor('kie', {...}) or routesFor({ kie: {...}, replicate: {} }) plus CDN routes. */
export function routesFor(spec, opts = {}) {
  const map = typeof spec === 'string' ? { [spec]: opts } : spec;
  return [...Object.entries(map).flatMap(([id, o]) => BUILDERS[id](o)), ...cdn()];
}

/** True when `call` is a job submission (generation request) to provider `id`. */
export function isSubmit(call, id) {
  if (call.method !== 'POST') return false;
  const u = call.url;
  switch (id) {
    case 'kie': return u === 'https://api.kie.ai/api/v1/jobs/createTask';
    case 'replicate': return /^https:\/\/api\.replicate\.com\/v1\/(models\/[^/]+\/[^/]+\/)?predictions$/.test(u);
    case 'wavespeed': return /^https:\/\/api\.wavespeed\.ai\/api\/v3\/(?!balance|model\/price|predictions)[^?]+$/.test(u);
    case 'fal': return /^https:\/\/queue\.fal\.run\//.test(u);
    default: throw new Error(`unknown provider ${id}`);
  }
}

export const submitCalls = (calls, id) =>
  calls.filter((c) => (id ? isSubmit(c, id) : Object.keys(HOSTS).some((p) => isSubmit(c, p))));

export const providerOfCall = (call) => {
  const host = new URL(call.url).hostname;
  return Object.keys(HOSTS).find((p) => HOSTS[p].includes(host)) ?? null;
};
