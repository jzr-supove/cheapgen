// `cheapgen status <job>` and `cheapgen wait <job>`; also the shared "wait, download, log
// the finished line" step that `run --wait` uses.
import path from 'node:path';
import { CliError, EXIT, usageError } from '../../errors.js';
import { ADAPTERS } from '../../providers/index.js';
import { ctxFor, connectedIds, noKeysError, notConnectedError, isEnabled } from '../../router.js';
import { parseJobId, waitForJob, downloadOutputs, TIMEOUT_MS } from '../../jobs.js';
import { appendSpend, findJob } from '../../spend-log.js';
import { usd } from '../output.js';
import { noExtraArgs, timeoutFlag } from './shared.js';

export function downloadDirFrom(app) {
  if (app.flags.download !== undefined && app.flags['no-download']) {
    throw usageError('pass either --download DIR or --no-download, not both');
  }
  if (app.flags['no-download']) return null;
  return path.resolve(app.io.cwd, app.flags.download ?? 'cheapgen-out');
}

function requireProvider(app, id) {
  if (connectedIds(app).length === 0) throw noKeysError();
  if (!app.keys[id]) throw notConnectedError(id);
  if (!isEnabled(app, id)) {
    throw new CliError(EXIT.NO_PROVIDER, 'disabled', `${id} is disabled in config (providers.${id}.enabled is false).`, { provider: id });
  }
}

/** "15 minutes", or "90 seconds" when it isn't a whole number of minutes. */
function describeWait(ms) {
  const [n, unit] = ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : [ms / 1000, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Waits for a job, downloads its outputs, and writes the `finished` spend-log line.
 * Throws exit code 7 on timeout; the `submitted` line stays as the record of the spend.
 */
export async function finishJob(app, { job, provider, nativeId, meta, kind, model, downloadDir, timeoutMs }) {
  const s = await waitForJob(app, { provider, nativeId, meta, timeoutMs });
  if (s.state === 'timeout') {
    throw new CliError(EXIT.TIMED_OUT, 'timeout', `job ${job} hasn't finished after ${describeWait(timeoutMs)}. `
      + `It may still finish: run \`cheapgen wait ${job}\` to keep waiting.`, { provider, job });
  }
  let files = [];
  if (s.state === 'succeeded' && downloadDir && s.outputs.length) {
    try {
      files = await downloadOutputs(app, s.outputs, { dir: downloadDir, model: model ?? 'output', kind });
    } catch (err) {
      app.out.warn(`${err.message}. The result links are still valid for a while.`);
    }
  }
  const rest = { ...(s.error ? { error: s.error } : {}), ...(s.actualUsd === undefined ? {} : { actualUsd: s.actualUsd }) };
  appendSpend(app, { event: 'finished', job, state: s.state, files, outputs: s.outputs, ...rest });
  return { state: s.state, outputs: s.outputs, files, ...rest };
}

/** "Charged: $0.0760", or "Not charged." for a job that cost nothing; '' when the charge isn't known. */
export function describeCharge({ actualUsd }) {
  if (actualUsd === undefined) return '';
  return actualUsd > 0 ? `Charged: ${usd(actualUsd)}` : 'Not charged.';
}

export function describeFinished(job, done) {
  if (done.state !== 'succeeded') {
    const charge = describeCharge(done).replace('Charged:', 'Charged');
    return `${job}: ${done.state}${done.error?.message ? ` (${done.error.message})` : ''}${charge ? `. ${charge}` : ''}`;
  }
  const lines = [`${job}: succeeded`];
  for (const f of done.files) lines.push(`  saved ${f}`);
  if (!done.files.length) for (const u of done.outputs) lines.push(`  ${u}`);
  const charge = describeCharge(done);
  if (charge) lines.push(charge);
  return lines.join('\n');
}

export async function status(app) {
  noExtraArgs(app, 1, 'cheapgen status <job>');
  const job = app.args[0];
  const { provider, nativeId } = parseJobId(job);
  requireProvider(app, provider);
  const record = findJob(app.io.homedir, job);
  let s;
  try {
    s = await ADAPTERS[provider].status(nativeId, ctxFor(app, provider), record?.meta);
  } catch (err) {
    throw new CliError(EXIT.BUG, 'status', `couldn't read the status of ${job}: ${err.message}`, { provider, job });
  }
  const text = [`${job}: ${s.state}`, ...s.outputs.map((u) => `  ${u}`), ...(s.error ? [`  ${s.error.message}`] : []),
    ...(s.actualUsd === undefined ? [] : [describeCharge(s)])].join('\n');
  app.out.result({ job, provider, ...s }, text);
  return EXIT.OK;
}

export async function wait(app) {
  noExtraArgs(app, 1, 'cheapgen wait <job>');
  const job = app.args[0];
  const { provider, nativeId } = parseJobId(job);
  const downloadDir = downloadDirFrom(app);
  const timeout = timeoutFlag(app);
  requireProvider(app, provider);
  const record = findJob(app.io.homedir, job);
  const kind = record?.model ? (app.catalog.models[record.model]?.kind ?? 'video') : 'video';
  const done = await finishJob(app, { job, provider, nativeId, meta: record?.meta, kind, model: record?.model,
    downloadDir, timeoutMs: timeout ?? TIMEOUT_MS[kind] });
  if (done.state !== 'succeeded') {
    throw new CliError(EXIT.JOB_FAILED, 'job_failed', describeFinished(job, done), { provider, job });
  }
  app.out.result({ job, provider, ...done }, describeFinished(job, done));
  return EXIT.OK;
}
