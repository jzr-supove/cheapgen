// `cheapgen quote <model> [params]`: price one request on every provider that offers it,
// sorted, marking the one `run` would choose.
import { CliError, EXIT } from '../../errors.js';
import { PROVIDER_IDS } from '../../config.js';
import { supports } from '../../providers/index.js';
import { rankCandidates, priceOf, compareQuotes, isEnabled } from '../../router.js';
import { staleWarnings } from '../../pricing/index.js';
import { describeRequest, logParams } from '../../request.js';
import { usd, table } from '../output.js';
import { requestFrom, excludeList, providerFlag } from './shared.js';

export async function quote(app) {
  const request = requestFrom(app, { requirePrompt: false });
  const provider = providerFlag(app);
  const exclude = excludeList(app);

  let chosen = null;
  let note = null;
  try {
    const { ranked } = await rankCandidates(app, request, { provider, exclude });
    chosen = ranked[0]?.provider ?? null;
  } catch (err) {
    if (!(err instanceof CliError) || err.exitCode !== EXIT.NO_PROVIDER) throw err;
    note = err.message;
  }

  const quotes = [];
  for (const id of PROVIDER_IDS) {
    if (!supports(app.catalog, id, request).ok) continue;
    const connected = Boolean(app.keys[id]);
    if (!connected && !app.config.showUnconnected) continue;
    const p = await priceOf(app, id, request);
    quotes.push({ provider: id, usd: p.usd, source: p.source, verifiedOn: p.verifiedOn ?? null, ageDays: p.ageDays ?? null,
      connected, enabled: isEnabled(app, id), chosen: id === chosen, ...(p.reason ? { reason: p.reason } : {}) });
  }
  quotes.sort((a, b) => compareQuotes(a, b, { prefer: app.config.prefer }));
  const warnings = staleWarnings(quotes);
  if (request.autoDuration) warnings.push(`auto duration: prices assume the maximum of ${request.maxDuration} seconds`);
  for (const w of warnings) app.out.warn(w);

  const rows = quotes.map((q) => [
    `  ${q.provider}`,
    usd(q.usd),
    q.source ? `${q.source} ${q.verifiedOn}` : '',
    [q.chosen ? '← run would use this' : '', !q.connected ? '(not connected)' : '', q.connected && !q.enabled ? '(disabled)' : '']
      .filter(Boolean).join(' '),
  ]);
  const text = [describeRequest(request), quotes.length ? table(rows) : '  no provider offers this request',
    ...(note && !chosen ? [`  ${note}`] : [])].join('\n');

  app.out.result({ model: request.model, mode: request.mode, params: logParams(request), quotes, chosen, warnings,
    ...(note ? { note } : {}) }, text);
  return EXIT.OK;
}
