// Helpers shared by commands.
import { usageError } from '../../errors.js';
import { buildCanonicalRequest } from '../../request.js';
import { checkProviderId } from '../../router.js';

export function noExtraArgs(app, max, usage) {
  if (app.args.length > max) throw usageError(`too many arguments. Usage: ${usage}`);
}

/** The canonical request from `<model>` and the shared flags. */
export function requestFrom(app, { requirePrompt }) {
  noExtraArgs(app, 1, `cheapgen ${requirePrompt ? 'run' : 'quote'} <model> [options]`);
  return buildCanonicalRequest(app.args[0], app.flags, app.catalog, { cwd: app.io.cwd, requirePrompt });
}

/** --exclude, repeatable and comma-separated. */
export function excludeList(app) {
  const ids = (app.flags.exclude ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  for (const id of ids) checkProviderId(id, '--exclude');
  return ids;
}

export function providerFlag(app) {
  return app.flags.provider === undefined ? undefined : checkProviderId(app.flags.provider, '--provider');
}

export function maxCostFlag(app) {
  const raw = app.flags['max-cost'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw usageError(`--max-cost must be a number of US dollars, got "${raw}"`);
  return n;
}

export function timeoutFlag(app) {
  const raw = app.flags.timeout;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw usageError(`--timeout must be a number of seconds, got "${raw}"`);
  return n * 1000;
}
