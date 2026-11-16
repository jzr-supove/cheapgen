// Fake `fetch` for tests. Routes are matched by method and URL; every call is recorded;
// any request that matches no route is recorded in `unmatched` and throws. The harness
// asserts `unmatched` is empty after every CLI run, so production code cannot hide an
// unexpected request by catching the thrown error. This is what proves "never contacts
// other providers" and "no network calls".
//
// Route: { method: 'GET'|'POST'|'*', url: string|RegExp,
//          status, json | body, headers,            // a single response, or
//          responses: [ response | (req) => response ],   // consumed in order, last repeats
//          error: Error,                            // make fetch throw (network error)
//          timeout: true }                          // make fetch throw a TimeoutError
// A response may also be a function (req) => response, where req = { method, url, headers, body }.
// String URLs match with or without a query string.

function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) {
    h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function parseBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return body; }
  }
  return '[binary or form body]';
}

function urlMatches(pattern, url) {
  if (pattern instanceof RegExp) return pattern.test(url);
  return url === pattern || url.split('?')[0] === pattern;
}

export function createFakeFetch(initialRoutes = []) {
  const calls = [];
  const unmatched = [];
  let entries = [];

  function setRoutes(routes) {
    entries = routes.map((route) => ({ route, hits: 0 }));
  }
  setRoutes(initialRoutes);

  async function fetch(input, init = {}) {
    const isReq = typeof input === 'object' && input !== null && !(input instanceof URL);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = String(init.method ?? (isReq ? input.method : undefined) ?? 'GET').toUpperCase();
    const req = {
      method,
      url,
      headers: normalizeHeaders(init.headers ?? (isReq ? input.headers : undefined)),
      body: parseBody(init.body),
    };
    calls.push(req);

    const entry = entries.find(({ route }) =>
      (route.method === '*' || (route.method ?? 'GET').toUpperCase() === method) && urlMatches(route.url, url));
    if (!entry) {
      unmatched.push(`${method} ${url}`);
      throw new Error(`fake fetch: unexpected request ${method} ${url}`);
    }

    const { route } = entry;
    let response = route;
    if (route.responses) {
      response = route.responses[Math.min(entry.hits, route.responses.length - 1)];
    }
    entry.hits += 1;
    if (typeof response === 'function') response = response(req);

    if (response.error) throw response.error;
    if (response.timeout) {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    const headers = { ...(response.headers ?? {}) };
    let body = response.body;
    if (response.json !== undefined) {
      body = JSON.stringify(response.json);
      headers['content-type'] ??= 'application/json';
    }
    return new Response(body ?? '', { status: response.status ?? 200, headers });
  }

  return {
    fetch,
    calls,
    unmatched,
    setRoutes,
    assertClean() {
      if (unmatched.length) {
        throw new Error(`requests matched no route (tests must not hit the network):\n  ${unmatched.join('\n  ')}`);
      }
    },
  };
}
