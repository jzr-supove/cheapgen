// Test client for the MCP server: builds the injected `io` the same way the CLI harness does
// (temp home and cwd, fake fetch, fixed clock), drives `createMcpServer().receive()` with JSON-RPC
// messages and records everything the server sends. The server module is imported lazily so a
// missing module fails each test with a clear message instead of crashing the whole file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEnvironment, DATA_DIR } from './harness.js';
import { submitCalls } from './providers.js';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';
export const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  caps: 'io.modelcontextprotocol/clientCapabilities',
  server: 'io.modelcontextprotocol/serverInfo',
};

export const TOOL_NAMES = ['models', 'providers', 'quote', 'run', 'job_status', 'wait_job', 'spend'];

/** The injected io the CLI (and the MCP server) run with, backed by a harness environment. */
export function buildIo(e, opts = {}) {
  const out = { stdout: '', stderr: '' };
  const io = {
    env: e.env,
    fetch: e.fake.fetch,
    stdout: { write(s) { out.stdout += s; return true; } },
    stderr: { write(s) { out.stderr += s; return true; } },
    stdin: '',
    homedir: e.home,
    cwd: e.cwd,
    now: () => new Date(e.clock.ms),
    sleep: async (ms) => { e.clock.ms += ms; },
    dataDir: opts.dataDir ?? DATA_DIR,
  };
  return { io, out };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param t     node:test context
 * @param opts  createEnvironment options (env, routes, userConfig, dataDir, now ...)
 */
export async function startMcp(t, opts = {}) {
  const { createMcpServer } = await import('../../src/mcp/server.js');
  const e = createEnvironment(t, opts);
  const { io, out } = buildIo(e, opts);
  const sent = [];
  const server = createMcpServer({ io, send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); } });
  let nextId = 0;
  const era = { kind: 'bare', caps: {} };

  const h = {
    e, io, out, sent, server,
    submits: () => submitCalls(e.calls).length,
    newId: () => { nextId += 1; return nextId; },
    replyFor: (id) => sent.find((m) => m.id === id && m.method === undefined && ('result' in m || 'error' in m)),

    /** Every message the server sent, as one string (for leak checks). */
    allSent: () => sent.map((m) => JSON.stringify(m)).join('\n'),

    async notify(method, params) {
      await server.receive({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },

    /** A request with no era metadata at all. */
    async raw(method, params) {
      const id = h.newId();
      await server.receive({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      const reply = h.replyFor(id);
      assert.ok(reply, `no reply was sent for ${method}`);
      return reply;
    },

    /** Initialize handshake (legacy era), then the initialized notification. */
    async useLegacy(caps = {}, protocolVersion = LEGACY) {
      const reply = await h.raw('initialize', { protocolVersion, capabilities: caps, clientInfo: { name: 'test-client', version: '1.0.0' } });
      assert.ok(reply.result, `initialize failed: ${JSON.stringify(reply)}`);
      await h.notify('notifications/initialized');
      era.kind = 'legacy';
      era.caps = caps;
      return reply;
    },

    /** Stateless era: every later request carries the version and capabilities in params._meta. */
    useModern(caps = {}, version = MODERN) {
      era.kind = 'modern';
      era.caps = caps;
      era.version = version;
    },

    metaFor(caps = era.caps, version = era.version ?? MODERN) {
      return {
        [META.version]: version,
        [META.clientInfo]: { name: 'test-client', version: '1.0.0' },
        [META.caps]: caps,
      };
    },

    /** A request in the current era. */
    async request(method, params = {}) {
      const body = era.kind === 'modern' ? { ...params, _meta: { ...(params._meta ?? {}), ...h.metaFor() } } : params;
      return h.raw(method, body);
    },

    /** tools/call; returns the whole JSON-RPC reply. `extra` is merged into params (inputResponses, requestState). */
    callRaw(name, args = {}, extra = {}) {
      return h.request('tools/call', { name, arguments: args, ...extra });
    },

    /** tools/call that must produce a result (not a JSON-RPC error). Returns the result. */
    async call(name, args = {}, extra = {}) {
      const reply = await h.callRaw(name, args, extra);
      assert.ok(reply.result, `${name} returned a JSON-RPC error: ${JSON.stringify(reply.error)}`);
      return reply.result;
    },

    /** A quote that must succeed. Returns its structuredContent. */
    async quote(args) {
      const r = await h.call('quote', args);
      assert.notEqual(r.isError, true, `quote failed: ${JSON.stringify(r)}`);
      assert.equal(typeof r.structuredContent?.quoteId, 'string');
      return r.structuredContent;
    },

    /** Waits until a message matching `pred` has been sent (for server-to-client requests). */
    async waitForSent(pred, what = 'a message') {
      for (let i = 0; i < 5000; i += 1) {
        const m = sent.find(pred);
        if (m) return m;
        await tick();
      }
      assert.fail(`the server never sent ${what}`);
    },
  };
  return h;
}

/** Runs `cheapgen mcp` through main() with the given input chunks. Resolves with the exit code and parsed output. */
export async function runStdio(t, chunks, opts = {}) {
  const { main } = await import('../../src/cli/main.js');
  const e = createEnvironment(t, opts);
  const { io, out } = buildIo(e, opts);
  io.mcpInput = (async function* input() {
    for (const c of chunks) {
      yield typeof c === 'string' && opts.asBuffer ? Buffer.from(c, 'utf8') : c;
      await tick();
    }
  }());
  const code = await main(['mcp'], io);
  const lines = out.stdout.split('\n');
  assert.equal(lines.at(-1), '', 'stdout ends with a newline after the last message');
  const messages = lines.slice(0, -1).map((l, i) => {
    assert.ok(l.length > 0, `stdout line ${i + 1} is empty`);
    try { return JSON.parse(l); } catch { return assert.fail(`stdout line ${i + 1} is not JSON: ${l.slice(0, 80)}`); }
  });
  return { code, messages, stdout: out.stdout, stderr: out.stderr, e };
}

export const line = (obj) => `${JSON.stringify(obj)}\n`;
