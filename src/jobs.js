// Polling and downloads.
import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usageError } from './errors.js';
import { PROVIDER_IDS } from './config.js';
import { ADAPTERS } from './providers/index.js';
import { ctxFor } from './router.js';

export const TIMEOUT_MS = { video: 15 * 60_000, image: 5 * 60_000 };
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Splits "<provider>:<nativeId>". */
export function parseJobId(job) {
  const m = /^([a-z]+):(.+)$/.exec(String(job ?? ''));
  if (!m || !PROVIDER_IDS.includes(m[1])) {
    throw usageError(`"${job ?? ''}" is not a job id. Job ids look like kie:task_123 (provider, colon, id).`);
  }
  return { provider: m[1], nativeId: m[2] };
}

/** Polls every 5 s, then every 15 s after the first minute, until the job ends or times out. */
export async function waitForJob(app, { provider, nativeId, meta, timeoutMs }) {
  const adapter = ADAPTERS[provider];
  const ctx = ctxFor(app, provider);
  const start = app.io.now().getTime();
  let lastError = null;
  for (;;) {
    try {
      const s = await adapter.status(nativeId, ctx, meta);
      if (TERMINAL.has(s.state)) return s;
      lastError = null;
    } catch (err) {
      // A client error (bad key, unknown job) won't fix itself; anything else is retried next poll.
      if (typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new CliError(EXIT.BUG, 'status', `couldn't check ${provider}:${nativeId}: ${err.message}`,
          { provider, job: `${provider}:${nativeId}` });
      }
      lastError = err;
    }
    const elapsed = app.io.now().getTime() - start;
    if (elapsed >= timeoutMs) return { state: 'timeout', lastError };
    await app.io.sleep(Math.min(elapsed < 60_000 ? 5_000 : 15_000, Math.max(1, timeoutMs - elapsed)));
  }
}

const EXT_BY_TYPE = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/png': 'png',
  'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function extensionFor(url, contentType, kind) {
  const fromUrl = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();
  return EXT_BY_TYPE[String(contentType ?? '').split(';')[0].trim()] ?? (kind === 'image' ? 'png' : 'mp4');
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Downloads each output URL into `dir`. Names are <model>-<YYYYMMDD-HHMMSS>-<n>.<ext>; existing
 * files are never overwritten. Returns paths relative to the working directory when inside it.
 */
export async function downloadOutputs(app, outputs, { dir, model, kind }) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  let n = 1;
  for (const url of outputs) {
    const { bytes, contentType } = await fetchBytes(app, url);
    const ext = extensionFor(url, contentType, kind);
    let file;
    for (;;) {
      file = path.join(dir, `${model}-${stamp(app.io.now())}-${n}.${ext}`);
      n += 1;
      try { fs.writeFileSync(file, bytes, { flag: 'wx' }); break; } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    const rel = path.relative(app.io.cwd, file);
    files.push(!rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file);
  }
  return files;
}

/** GET with no auth header (result URLs are public CDN links), keeping the raw bytes. */
async function fetchBytes(app, url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await app.io.fetch(url, { method: 'GET', signal: AbortSignal.timeout(300_000) });
      if (res.ok) return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status < 500) break;
    } catch (err) {
      lastErr = err;
    }
    await app.io.sleep(1000 * 2 ** attempt);
  }
  throw new CliError(EXIT.BUG, 'download', `couldn't download ${url}: ${lastErr?.message ?? 'unknown error'}`);
}
