// Read-only commands: `providers`, `models`, `spend`, `prices`.
import { EXIT, usageError } from '../../errors.js';
import { PROVIDER_IDS, ENV_VARS } from '../../config.js';
import { ADAPTERS } from '../../providers/index.js';
import { connectedIds, noKeysError, isEnabled, balanceOf } from '../../router.js';
import { readSpend, joinJobs } from '../../spend-log.js';
import { ageInDays, STALE_AFTER_DAYS } from '../../pricing/index.js';
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
  });
  const known = jobs.filter((j) => typeof j.estimateUsd === 'number');
  const totalUsd = known.reduce((sum, j) => sum + j.estimateUsd, 0);
  const note = 'These are cheapgen\'s estimates. Your provider\'s bill is authoritative.';
  const out = jobs.map(({ meta, ...j }) => j);
  const rows = out.map((j) => [j.submittedAt?.slice(0, 16).replace('T', ' ') ?? '', j.job, j.model ?? '', j.state, usd(j.estimateUsd)]);
  const text = [jobs.length ? table(rows) : 'No jobs in the spend log.',
    `Total: $${totalUsd.toFixed(2)}${known.length < jobs.length ? ` (+ ${jobs.length - known.length} with unknown price)` : ''}`,
    note].join('\n');
  app.out.result({ since: app.flags.since ?? null, totalUsd, unknownEstimates: jobs.length - known.length, jobs: out, note }, text);
  return EXIT.OK;
}

export async function prices(app) {
  noExtraArgs(app, 1, 'cheapgen prices [model] [--check]');
  const now = app.io.now();
  const model = app.args[0];
  if (model && !app.catalog.models[model]) throw usageError(`unknown model "${model}"`);
  const entries = app.catalog.prices.entries.filter((e) => !model || e.model === model)
    .map((e) => ({ provider: e.provider, model: e.model, mode: e.mode, when: e.when, pricing: e.pricing,
      sourceUrl: e.sourceUrl, verifiedOn: e.verifiedOn, ageDays: ageInDays(e.verifiedOn, now) }));
  if (app.flags.check) {
    const stale = entries.filter((e) => e.ageDays > STALE_AFTER_DAYS);
    const note = 'Comparing against live provider prices is not implemented yet; this checks how old the bundled prices are.';
    const text = [`${entries.length} bundled prices, ${stale.length} older than ${STALE_AFTER_DAYS} days.`,
      ...stale.map((e) => `  ${e.provider} ${e.model} ${JSON.stringify(e.when)}: verified ${e.verifiedOn} (${e.ageDays} days ago)`),
      note].join('\n');
    app.out.result({ checked: entries.length, stale, note }, text);
    return EXIT.OK;
  }
  const rows = entries.map((e) => [e.provider, e.model, Object.values(e.when ?? {}).flat().join('/') || '*', e.pricing.type,
    e.verifiedOn]);
  app.out.result({ entries }, entries.length ? table(rows) : 'No bundled prices.');
  return EXIT.OK;
}
