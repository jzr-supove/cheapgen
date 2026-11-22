// Read-only commands: `providers`, `models`, `spend`, `prices`.
import { EXIT, usageError } from '../../errors.js';
import { PROVIDER_IDS, ENV_VARS } from '../../config.js';
import { ADAPTERS } from '../../providers/index.js';
import { connectedIds, noKeysError, isEnabled, balanceOf } from '../../router.js';
import { readSpend, joinJobs } from '../../spend-log.js';
import { ageInDays, STALE_AFTER_DAYS } from '../../pricing/index.js';
import { checkPrices, summarize } from '../../pricing/check.js';
import { usd, table } from '../output.js';
import { noExtraArgs } from './shared.js';

export async function providers(app) {
  noExtraArgs(app, 0, 'cheapgen providers');
  if (connectedIds(app).length === 0) throw noKeysError();
  const list = [];
  for (const id of PROVIDER_IDS) {
    const connected = Boolean(app.keys[id]);
    const enabled = isEnabled(app, id);
    list.push({ id, name: ADAPTERS[id].displayName, envVar: ENV_VARS[id], connected, keySource: app.keySources[id],
      enabled, balance: connected && enabled ? await balanceOf(app, id) : null });
  }
  const rows = list.map((p) => [p.id,
    p.connected ? `connected (key from ${p.keySource === 'env' ? p.envVar : 'config file'})` : `not connected (set ${p.envVar})`,
    p.enabled ? 'enabled' : 'disabled',
    p.balance !== null ? `balance $${p.balance.toFixed(2)}` : p.connected && p.enabled ? 'balance unknown' : '']);
  app.out.result({ providers: list }, table(rows));
  return EXIT.OK;
}

export async function models(app) {
  noExtraArgs(app, 0, 'cheapgen models [--search TEXT]');
  const q = app.flags.search?.toLowerCase();
  const list = Object.entries(app.catalog.models)
    .filter(([id]) => !q || id.toLowerCase().includes(q))
    .map(([id, m]) => ({
      id, kind: m.kind, modes: m.modes,
      ...(m.kind === 'video' ? { resolutions: m.resolutions, durations: m.durations } : { sizes: m.sizes ?? [] }),
      aspectRatios: m.aspectRatios,
      providers: Object.keys(m.providers ?? {}).filter((p) => PROVIDER_IDS.includes(p))
        .map((p) => ({ id: p, connected: Boolean(app.keys[p]) })),
    }));
  const rows = list.map((m) => [m.id, m.kind, (m.resolutions ?? m.sizes).join('/'),
    m.providers.map((p) => (p.connected ? `${p.id}*` : p.id)).join(', ')]);
  const text = list.length ? `${table(rows)}\n(* = connected)` : `no model matches "${app.flags.search}"`;
  app.out.result({ models: list }, text);
  return EXIT.OK;
}

/** Fills in $0 for a failed job with no reported charge, on a provider that doesn't bill those. */
function withFreeFailures(j) {
  const free = j.actualUsd === null && j.state === 'failed' && ADAPTERS[j.job.split(':')[0]]?.billing?.failedJobFree;
  return free ? { ...j, actualUsd: 0 } : j;
}

export async function spend(app) {
  noExtraArgs(app, 0, 'cheapgen spend [--since DATE]');
  let since = null;
  if (app.flags.since !== undefined) {
    since = Date.parse(app.flags.since);
    if (Number.isNaN(since)) throw usageError(`--since needs a date like 2026-11-01, got "${app.flags.since}"`);
  }
  const jobs = joinJobs(readSpend(app.io.homedir)).filter((j) => {
    if (since === null) return true;
    const at = Date.parse(j.submittedAt ?? j.finishedAt ?? '');
    return !Number.isNaN(at) && at >= since;
  }).map(withFreeFailures);
  const sum = (list, field) => list.reduce((total, j) => total + j[field], 0);
  const charged = jobs.filter((j) => j.actualUsd !== null);
  const estimated = jobs.filter((j) => j.actualUsd === null && typeof j.estimateUsd === 'number');
  const chargedUsd = sum(charged, 'actualUsd');
  const estimatedUsd = sum(estimated, 'estimateUsd');
  const totalUsd = chargedUsd + estimatedUsd;
  const unknownEstimates = jobs.length - charged.length - estimated.length;
  const note = '"charged" is what the provider reported ($0 for failed Replicate jobs, which it doesn\'t bill); '
    + '"estimate" is cheapgen\'s. Your provider\'s bill is authoritative.';
  const amount = (j) => (j.actualUsd !== null ? `${usd(j.actualUsd)} charged`
    : typeof j.estimateUsd === 'number' ? `${usd(j.estimateUsd)} estimate` : usd(null));
  const out = jobs.map(({ meta, ...j }) => j);
  const rows = out.map((j) => [j.submittedAt?.slice(0, 16).replace('T', ' ') ?? '', j.job, j.model ?? '', j.state, amount(j)]);
  const text = [jobs.length ? table(rows) : 'No jobs in the spend log.',
    `Total: $${totalUsd.toFixed(2)}${unknownEstimates ? ` (+ ${unknownEstimates} with unknown price)` : ''}`,
    note].join('\n');
  app.out.result({ since: app.flags.since ?? null, totalUsd, chargedUsd, estimatedUsd, unknownEstimates, jobs: out, note }, text);
  return EXIT.OK;
}

export async function prices(app) {
  noExtraArgs(app, 1, 'cheapgen prices [model] [--check]');
  const now = app.io.now();
  const model = app.args[0];
  if (model && !app.catalog.models[model]) throw usageError(`unknown model "${model}"`);
  const selected = app.catalog.prices.entries.filter((e) => !model || e.model === model);
  const entries = selected
    .map((e) => ({ provider: e.provider, model: e.model, mode: e.mode, when: e.when, pricing: e.pricing,
      sourceUrl: e.sourceUrl, verifiedOn: e.verifiedOn, ageDays: ageInDays(e.verifiedOn, now) }));
  if (app.flags.check) {
    // Exit 0 even when prices changed: the weekly job reads summary.changed.
    const stale = entries.filter((e) => e.ageDays > STALE_AFTER_DAYS);
    const results = await checkPrices(app, selected);
    const summary = summarize(results);
    const label = (r) => `${r.provider} ${r.model} ${Object.values(r.when ?? {}).flat().join('/') || '*'}`;
    const lines = [`Checked ${results.length} bundled prices: ${summary.same} same, ${summary.changed} changed, `
      + `${summary.missing} missing, ${summary.unavailable} unavailable, ${summary.unchecked} unchecked.`];
    for (const r of results.filter((x) => x.status === 'changed')) {
      lines.push(`  changed      ${label(r)}: ${r.bundledUsd} -> ${r.liveUsd} per ${r.unit}`);
    }
    for (const r of results.filter((x) => x.status === 'missing' || x.status === 'unavailable')) {
      lines.push(`  ${r.status.padEnd(12)} ${label(r)}: ${r.reason}`);
    }
    const unchecked = new Map();
    for (const r of results.filter((x) => x.status === 'unchecked')) {
      const k = `${ADAPTERS[r.provider]?.displayName ?? r.provider}: ${r.reason}`;
      unchecked.set(k, (unchecked.get(k) ?? 0) + 1);
    }
    for (const [k, n] of unchecked) lines.push(`  unchecked    ${k} (${n})`);
    if (stale.length) {
      lines.push(`${stale.length} bundled prices are older than ${STALE_AFTER_DAYS} days:`,
        ...stale.map((e) => `  ${e.provider} ${e.model} ${JSON.stringify(e.when)}: verified ${e.verifiedOn} (${e.ageDays} days ago)`));
    }
    app.out.result({ checkedOn: now.toISOString(), results, summary, stale }, lines.join('\n'));
    return EXIT.OK;
  }
  const rows = entries.map((e) => [e.provider, e.model, Object.values(e.when ?? {}).flat().join('/') || '*', e.pricing.type,
    e.verifiedOn]);
  app.out.result({ entries }, entries.length ? table(rows) : 'No bundled prices.');
  return EXIT.OK;
}
