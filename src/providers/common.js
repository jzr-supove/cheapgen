// Helpers shared by the adapters.
import fs from 'node:fs';
import path from 'node:path';
import { http, NetworkError, describeBody } from '../http.js';
import { SubmitRejected, SubmitUnknown } from './errors.js';

export const SUBMIT_TIMEOUT_MS = 120_000;

/**
 * Sends a job submission and classifies transport-level failures:
 * network errors, timeouts and 5xx are unknown outcomes; 4xx are clear rejections.
 * The caller still checks the body for a job id and any provider envelope code.
 */
export async function postJob(ctx, req) {
  let res;
  try {
    res = await http(ctx, { ...req, method: 'POST', timeoutMs: SUBMIT_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof NetworkError) {
      throw new SubmitUnknown(err.timeout ? 'the submit request timed out' : err.message);
    }
    throw err;
  }
  if (res.status >= 500) throw new SubmitUnknown(`HTTP ${res.status}: ${describeBody(res)}`, { status: res.status });
  if (res.status >= 400) throw new SubmitRejected(`HTTP ${res.status}: ${describeBody(res)}`, { status: res.status });
  return res;
}

/** GET (retried by the HTTP layer) that throws a plain Error on a non-2xx answer. */
export async function getJson(ctx, url, headers) {
  const res = await http(ctx, { method: 'GET', url, headers, timeoutMs: 30_000 });
  if (!res.ok) throw readError(`HTTP ${res.status}: ${describeBody(res)}`, res.status);
  return res.json;
}

/** An error from a read, carrying the HTTP (or envelope) status so callers can tell 4xx from 5xx. */
export function readError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Reads a local file into a Blob for multipart uploads. */
export function fileBlob(filePath) {
  return { blob: new Blob([fs.readFileSync(filePath)]), name: path.basename(filePath) };
}

/** Wraps an upload so any failure counts as a clear rejection: no job exists yet. */
export async function asRejection(what, fn) {
  try {
    const url = await fn();
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('no file URL in the response');
    return url;
  } catch (err) {
    if (err instanceof SubmitRejected) throw err;
    throw new SubmitRejected(`couldn't upload ${what}: ${err.message}`);
  }
}

/** Placeholder shown in dry runs for a local image that would be uploaded at run time. */
export const pendingUpload = (filePath) => `(local file ${path.basename(filePath)}, uploaded at run time)`;

/** Video fields shared by most providers: resolution, duration, aspect ratio, audio. */
export function videoFields(r, { durationAsString = false } = {}) {
  let duration = r.duration;
  if (r.autoDuration) duration = durationAsString ? 'auto' : -1;
  else if (durationAsString) duration = String(r.duration);
  return { resolution: r.resolution, duration, aspect_ratio: r.aspectRatio, generate_audio: r.audio };
}
