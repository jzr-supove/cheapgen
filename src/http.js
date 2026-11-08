// HTTP helpers and key redaction.
//
// - POST requests are never retried here: a retried submit could create and bill a second job.
// - GET requests are retried on network errors and 5xx responses, with backoff via ctx.sleep.
// - Nothing here logs headers or bodies. Callers pass provider messages through redact().

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATTERNS = [
  [/\bBearer\s+[^\s"',;)]+/gi, 'Bearer [redacted]'],
  [/\bKey\s+[\w.-]+:[\w.-]+/g, 'Key [redacted]'],
  [/\br8_[A-Za-z0-9]{8,}/g, '[redacted]'],
];

/**
 * Removes the given keys and common key formats from text.
 * @param {string} text
 * @param {string[]} keys
 * @returns {string}
 */
export function redact(text, keys = []) {
  let out = String(text ?? '');
  const literal = [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const key of literal) out = out.replace(new RegExp(escapeRegExp(key), 'g'), '[redacted]');
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Thrown when fetch itself fails (network drop, DNS, timeout). */
export class NetworkError extends Error {
  constructor(message, { timeout = false } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.timeout = timeout;
  }
}

/**
 * Sends one request and reads the body as JSON when possible.
 * @param {{ fetch: typeof fetch, sleep?: (ms: number) => Promise<void> }} ctx
 * @param {{ method?: string, url: string, headers?: object, json?: unknown, body?: any,
 *           timeoutMs?: number, retries?: number }} req
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string, headers: Headers }>}
 */
export async function http(ctx, req) {
  const method = (req.method ?? 'GET').toUpperCase();
  const retries = method === 'GET' ? (req.retries ?? 2) : 0;
  let attempt = 0;
  for (;;) {
    try {
      const res = await once(ctx, method, req);
      if (res.status >= 500 && attempt < retries) {
        attempt += 1;
        await ctx.sleep?.(500 * 2 ** (attempt - 1));
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof NetworkError && attempt < retries) {
        attempt += 1;
        await ctx.sleep?.(500 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }
}

async function once(ctx, method, req) {
  const headers = { ...(req.headers ?? {}) };
  let body = req.body;
  if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    headers['Content-Type'] ??= 'application/json';
  }
  let res;
  try {
    res = await ctx.fetch(req.url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new NetworkError(timeout ? 'request timed out' : `network error: ${err?.message ?? err}`, { timeout });
  }
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

/** A short description of a provider's error body, for messages. */
export function describeBody(res) {
  const j = res.json;
  if (j && typeof j === 'object') {
    const msg = j.msg ?? j.message ?? j.detail ?? j.error?.message ?? j.error ?? j.title;
    if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg);
  }
  return res.text ? res.text.slice(0, 200) : `HTTP ${res.status}`;
}
