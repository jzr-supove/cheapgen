// stdio transport: newline-delimited JSON-RPC in; each outgoing message goes to `write`, which
// prints it as one line. Only protocol messages go to stdout.
import { StringDecoder } from 'node:string_decoder';
import { createMcpServer } from './server.js';

/**
 * Serves MCP over a stream of input chunks until it ends.
 * @param {{ io: object, input: AsyncIterable<string|Buffer>, write: (message: object) => void }} options
 */
export async function serveStdio({ io, input, write }) {
  const server = createMcpServer({ io, send: write });
  const inFlight = new Set();
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const handle = (raw) => {
    const text = raw.replace(/\r$/, '');
    if (!text.trim()) return;
    let msg;
    try { msg = JSON.parse(text); } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Not awaited: a tool call can wait for the client's answer, which arrives on a later line.
    const p = server.receive(msg).catch(() => {}).finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.end();
  handle(buffer);
  server.close();
  while (inFlight.size) await Promise.all([...inFlight]);
}
