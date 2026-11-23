// `cheapgen mcp`: run the MCP server on stdin and stdout, for agents that start it themselves.
import { EXIT } from '../../errors.js';
import { serveStdio } from '../../mcp/stdio.js';
import { noExtraArgs } from './shared.js';

/** Redacts every string inside a message, so the line stays valid JSON. */
function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redactDeep(v, redact)]));
  }
  return value;
}

export async function mcp(app) {
  noExtraArgs(app, 0, 'cheapgen mcp');
  const input = app.io.mcpInput ?? process.stdin;
  await serveStdio({ io: app.io, input, write: (msg) => app.io.stdout.write(`${JSON.stringify(redactDeep(msg, app.redact))}\n`) });
  return EXIT.OK;
}
