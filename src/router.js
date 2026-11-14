// Routing: candidates, ranking, balance check. Submitting and fallback live in
// the `run` command, which uses the ranked list built here.
import { CliError, EXIT, usageError } from './errors.js';
import { PROVIDER_IDS, ENV_VARS } from './config.js';
import { ADAPTERS, supports } from './providers/index.js';
import { priceFor, cacheKey } from './pricing/index.js';
import { describeRequest } from './request.js';

const BALANCE_TTL_MS = 60_000;
const EPS = 1e-9;

export const envVarList = () => PROVIDER_IDS.map((id) => `${ENV_VARS[id]} (${ADAPTERS[id].displayName})`).join(', ');

export function noKeysError() {
  return new CliError(EXIT.NO_PROVIDER, 'no_keys',
    `no provider is connected. Set at least one of ${envVarList()}, `
    + 'or store a key with `cheapgen config set-key <provider>`.');
}

export function notConnectedError(id) {
  return new CliError(EXIT.NO_PROVIDER, 'not_connected',
    `${id} isn't connected: set ${ENV_VARS[id]} or run \`cheapgen config set-key ${id}\`.`, { provider: id });
}

export const connectedIds = (app) => PROVIDER_IDS.filter((id) => app.keys[id]);
export const isEnabled = (app, id) => app.config.providers[id]?.enabled !== false;

export function checkProviderId(id, flag) {
  if (!PROVIDER_IDS.includes(id)) throw usageError(`unknown provider "${id}" in ${flag}. Providers: ${PROVIDER_IDS.join(', ')}`);
  return id;
}

/** Adapter context: everything an adapter may touch. Keys are passed in, never read from env. */
export function ctxFor(app, id) {
  return { key: app.keys[id], fetch: app.io.fetch, now: app.io.now, sleep: app.io.sleep };
}

/** Price of `request` on provider `id`, memoized for this command. Live only when connected and enabled. */
export async function priceOf(app, id, request) {
  const memoKey = cacheKey(id, request);
  if (!app.priceMemo.has(memoKey)) {
    const live = Boolean(app.keys[id]) && isEnabled(app, id);
    app.priceMemo.set(memoKey, priceFor({ adapter: ADAPTERS[id], request, catalog: app.catalog,
      ctx: live ? ctxFor(app, id) : null, cache: app.priceCache, now: app.io.now() }));
  }
  return app.priceMemo.get(memoKey);
}

/** Balance in USD or null (unknown), cached for 60 seconds within this process. */
export async function balanceOf(app, id) {
  const now = app.io.now().getTime();
  const hit = app.balanceMemo.get(id);
  if (hit && now - hit.at < BALANCE_TTL_MS) return hit.value;
  let value = null;
  try { value = await ADAPTERS[id].balance(ctxFor(app, id)); } catch { value = null; }
  if (typeof value !== 'number' || !Number.isFinite(value)) value = null;
  app.balanceMemo.set(id, { at: now, value });
  return value;
}

/** Sort order: known prices ascending, unknown last; ties by prefer order, then id. */
export function compareQuotes(a, b, { prefer = [], strategy = 'cheapest' } = {}) {
  const rank = (id) => { const i = prefer.indexOf(id); return i === -1 ? Infinity : i; };
  const byPrefer = rank(a.provider) - rank(b.provider);
  if (strategy === 'preferred' && byPrefer !== 0 && !Number.isNaN(byPrefer)) return byPrefer;
  const ua = a.usd;
  const ub = b.usd;
  if (ua === null && ub !== null) return 1;
  if (ub === null && ua !== null) return -1;
  if (ua !== null && ub !== null && Math.abs(ua - ub) > EPS) return ua - ub;
  if (byPrefer !== 0 && !Number.isNaN(byPrefer)) return byPrefer;
  return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
}

/**
 * Builds the ranked list of providers `run` would try, in order.
 * @param {object} app
 * @param {object} request   canonical request
 * @param {{ provider?: string, exclude?: string[] }} flags
 * @returns {Promise<{ ranked: Array<{ provider: string, entry: object, usd: number|null, source: string|null,
 *            verifiedOn: string|null }>, pinned: boolean, dropped: Array<{ provider: string, reason: string }> }>}
 */
export async function rankCandidates(app, request, { provider, exclude = [] } = {}) {
  const connected = connectedIds(app);
  if (connected.length === 0) throw noKeysError();

  const pin = provider ?? app.config.models[request.model]?.provider;
  const dropped = [];
  let list;
  if (pin) {
    checkProviderId(pin, provider ? '--provider' : `config models.${request.model}.provider`);
    if (!app.keys[pin]) throw notConnectedError(pin);
    if (!isEnabled(app, pin)) {
      throw new CliError(EXIT.NO_PROVIDER, 'disabled', `${pin} is disabled in config (providers.${pin}.enabled is false).`, { provider: pin });
    }
    const s = supports(app.catalog, pin, request);
    if (!s.ok) {
      throw new CliError(EXIT.NO_PROVIDER, 'unsupported', `${s.reason}. It was chosen with ${provider ? '--provider' : 'a config pin'}, `
        + 'so no other provider is used.', { provider: pin });
    }
    list = [{ provider: pin, entry: s.entry }];
  } else {
    list = [];
    for (const id of connected) {
      if (!isEnabled(app, id)) continue;
      if (exclude.includes(id)) continue;
      const s = supports(app.catalog, id, request);
      if (s.ok) list.push({ provider: id, entry: s.entry });
      else dropped.push({ provider: id, reason: s.reason });
    }
    if (list.length === 0) {
      throw new CliError(EXIT.NO_PROVIDER, 'unsupported',
        `no connected, enabled provider offers ${describeRequest(request)}.`);
    }
  }

  const priced = [];
  for (const c of list) {
    const p = await priceOf(app, c.provider, request);
    const candidate = { ...c, usd: p.usd, source: p.source, verifiedOn: p.verifiedOn ?? null, reason: p.reason };
    if (p.usd !== null) {
      const balance = await balanceOf(app, c.provider);
      if (balance !== null && balance + EPS < p.usd) {
        dropped.push({ provider: c.provider, reason: `${c.provider}'s balance ($${balance.toFixed(2)}) can't cover the estimate` });
        continue;
      }
    }
    priced.push(candidate);
  }
  if (priced.length === 0) {
    const why = dropped.filter((d) => /balance/.test(d.reason)).map((d) => d.reason).join('; ');
    throw new CliError(EXIT.NO_PROVIDER, 'insufficient_balance', `no connected provider can pay for this request: ${why}.`);
  }

  const order = { prefer: app.config.prefer, strategy: app.config.strategy };
  priced.sort((a, b) => compareQuotes(a, b, order));
  return { ranked: priced, pinned: Boolean(pin), dropped };
}
