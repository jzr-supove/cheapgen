// `cheapgen run <model> [params]`: route, check the cost limit, submit with fallback,
// log the spend, and optionally wait and download.
import { CliError, EXIT } from '../../errors.js';
import { ADAPTERS } from '../../providers/index.js';
import { SubmitRejected, SubmitUnknown } from '../../providers/errors.js';
import { pendingUpload } from '../../providers/common.js';
import { rankCandidates, ctxFor } from '../../router.js';
import { TIMEOUT_MS } from '../../jobs.js';
import { appendSpend } from '../../spend-log.js';
import { describeRequest, logParams } from '../../request.js';
import { usd } from '../output.js';
import { requestFrom, excludeList, providerFlag, maxCostFlag, timeoutFlag } from './shared.js';
import { finishJob, describeFinished, downloadDirFrom } from './jobs.js';

const EPS = 1e-9;

export async function run(app) {
  const { flags, out } = app;
  const request = requestFrom(app, { requirePrompt: true });
  const provider = providerFlag(app);
  const exclude = excludeList(app);
  const limit = maxCostFlag(app) ?? app.config.maxCostPerRun;
  const downloadDir = downloadDirFrom(app);
  const timeoutMs = timeoutFlag(app) ?? TIMEOUT_MS[request.kind];

  const { ranked, pinned } = await rankCandidates(app, request, { provider, exclude });
  const first = ranked[0];
  const overLimit = first.usd !== null && first.usd > limit + EPS;

  if (flags['dry-run']) return dryRun(app, request, ranked, { limit, overLimit });

  if (!flags.yes) {
    if (first.usd === null) {
      throw new CliError(EXIT.NEEDS_CONFIRMATION, 'price_unknown', `the price of ${describeRequest(request)} on ${first.provider} `
        + 'is unknown, so it needs confirmation. Re-run with --yes to start it anyway.', { provider: first.provider });
    }
    if (overLimit) {
      throw new CliError(EXIT.NEEDS_CONFIRMATION, 'over_limit', `the estimate of ${usd(first.usd)} on ${first.provider} is above `
        + `your limit of $${limit.toFixed(2)} per run (maxCostPerRun). Re-run with --yes, or with --max-cost N for this run.`,
      { provider: first.provider });
    }
  }
  // With --yes the user accepted the first estimate; fallbacks may cost up to that, never more.
  const ceiling = flags.yes ? (first.usd === null ? Infinity : Math.max(limit, first.usd)) : limit;

  let lastRejection = null;
  let lastFailure = null;
  let stoppedByLimit = null;
  for (let i = 0; i < ranked.length; i += 1) {
    const c = ranked[i];
    if (i > 0 && !(c.usd === null ? flags.yes : c.usd <= ceiling + EPS)) { stoppedByLimit = c; break; }
    const adapter = ADAPTERS[c.provider];
    const ctx = ctxFor(app, c.provider);

    let accepted;
    try {
      const imageUrl = !request.image ? undefined
        : request.imageIsLocal ? await adapter.upload(request.image, ctx) : request.image;
      accepted = await adapter.submit(request, ctx, { entry: c.entry, imageUrl });
    } catch (err) {
      if (err instanceof SubmitRejected) {
        lastRejection = { provider: c.provider, message: err.message };
        if (pinned) {
          throw new CliError(EXIT.NO_PROVIDER, 'rejected', `${c.provider} rejected the job (${err.message}). It was chosen `
            + 'explicitly, so no other provider was tried.', { provider: c.provider });
        }
        const next = ranked[i + 1];
        out.notice(`${c.provider} rejected the job (${err.message})${next ? `; trying ${next.provider}` : ''}.`);
        continue;
      }
      if (err instanceof SubmitUnknown) {
        throw new CliError(EXIT.UNKNOWN_OUTCOME, 'unknown_outcome', `the outcome of the submit to ${c.provider} is unknown `
          + `(${err.message}). A job may have been created and billed, so no other provider was tried. Check your `
          + `${adapter.displayName} dashboard before running again.`, { provider: c.provider });
      }
      throw err;
    }

    const job = `${c.provider}:${accepted.nativeId}`;
    appendSpend(app, { event: 'submitted', job, provider: c.provider, model: request.model, mode: request.mode,
      params: logParams(request), estimateUsd: c.usd, priceSource: c.source, ...(accepted.meta ? { meta: accepted.meta } : {}) });
    const base = { job, provider: c.provider, model: request.model, estimateUsd: c.usd, priceSource: c.source,
      verifiedOn: c.verifiedOn };

    if (!flags.wait) {
      out.result({ ...base, state: 'submitted' }, `Submitted to ${c.provider}: ${job}\n`
        + `Estimate: ${usd(c.usd)}${c.source ? ` (${c.source} price, ${c.verifiedOn})` : ''}\n`
        + `Check it with: cheapgen wait ${job}`);
      return EXIT.OK;
    }

    out.notice(`Submitted to ${c.provider}: ${job} (estimate ${usd(c.usd)}). Waiting for it to finish...`);
    const done = await finishJob(app, { job, provider: c.provider, nativeId: accepted.nativeId, meta: accepted.meta,
      kind: request.kind, model: request.model, downloadDir, timeoutMs });
    if (done.state === 'succeeded') {
      out.result({ ...base, ...done }, `${describeFinished(job, done)}\nEstimate: ${usd(c.usd)}`);
      return EXIT.OK;
    }

    lastFailure = { job, provider: c.provider, done };
    const next = ranked[i + 1];
    const retry = app.config.retryFailedJobs && done.error?.providerFault && !adapter.billing.failedJobCharged && next;
    if (!retry) break;
    out.notice(`${job} failed on ${c.provider}'s side (${done.error.message}); ${c.provider} doesn't charge for that, `
      + `so retrying on ${next.provider} (retryFailedJobs is on).`);
  }

  if (lastFailure) {
    throw new CliError(EXIT.JOB_FAILED, 'job_failed', describeFinished(lastFailure.job, lastFailure.done),
      { provider: lastFailure.provider, job: lastFailure.job });
  }
  if (stoppedByLimit) {
    throw new CliError(EXIT.NEEDS_CONFIRMATION, 'over_limit', `${lastRejection?.provider ?? 'the first provider'} rejected the job, `
      + `and the next provider, ${stoppedByLimit.provider}, would cost ${usd(stoppedByLimit.usd)}, above your limit of `
      + `$${limit.toFixed(2)}. Nothing was submitted. Re-run with --max-cost N or --yes to allow it.`, { provider: stoppedByLimit.provider });
  }
  throw new CliError(EXIT.NO_PROVIDER, 'all_rejected', `every connected provider rejected the job. The last one, `
    + `${lastRejection.provider}, said: ${lastRejection.message}`, { provider: lastRejection.provider });
}

function dryRun(app, request, ranked, { limit, overLimit }) {
  const first = ranked[0];
  const imageUrl = !request.image ? undefined : request.imageIsLocal ? pendingUpload(request.image) : request.image;
  const built = ADAPTERS[first.provider].buildRequest(request, { entry: first.entry, imageUrl });
  const fallbacks = ranked.slice(1).map((c) => ({ provider: c.provider, estimateUsd: c.usd }));
  const text = [
    `Dry run: nothing was sent.`,
    `${describeRequest(request)}`,
    `Would send to ${first.provider}, estimate ${usd(first.usd)}${first.source ? ` (${first.source} price, ${first.verifiedOn})` : ''}`
      + `${overLimit ? `, above your $${limit.toFixed(2)} limit (needs --yes)` : ''}${first.usd === null ? ' (needs --yes)' : ''}`,
    `${built.method} ${built.url}`,
    JSON.stringify(built.body, null, 2),
    ...(fallbacks.length ? [`If it's rejected: ${fallbacks.map((f) => `${f.provider} ${usd(f.estimateUsd)}`).join(', ')}`] : []),
  ].join('\n');
  app.out.result({ dryRun: true, provider: first.provider, estimateUsd: first.usd, priceSource: first.source,
    verifiedOn: first.verifiedOn, limitUsd: limit, overLimit, needsConfirmation: overLimit || first.usd === null,
    request: built, fallbacks }, text);
  return EXIT.OK;
}
