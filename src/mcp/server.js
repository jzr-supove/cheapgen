// MCP server: JSON-RPC message handling for both protocol eras. Legacy clients open with
// `initialize`; modern clients (2026-07-28) send the version and their capabilities in each
// request's `_meta`. No transport here: `receive` takes parsed messages, `send` writes them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TOOL_DEFINITIONS, callTool } from './tools.js';
import { RpcError } from './errors.js';

export { RpcError };

export const MODERN = '2026-07-28';
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SUPPORTED = [MODERN, ...LEGACY];
const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
};
const CLIENT_REQUEST_TIMEOUT_MS = 5 * 60_000;

export const INSTRUCTIONS = 'cheapgen prices AI video and image generations on every connected provider and runs them '
  + 'on the cheapest. Call `quote` first and tell the user the provider and price. `run` spends the user\'s money: '
  + 'call it only after the user agreed to that price, with the quoteId from `quote`. Above the user\'s cost limit, '
  + 'the server asks the user itself when the app supports it. Never resubmit after an unknown_outcome error. '
  + '`run` returns a job id; collect the result with `wait_job`.';

let serverVersion;
function serverInfo() {
  serverVersion ??= JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  return { name: 'cheapgen', version: serverVersion };
}

/**
 * @param {{ io: object, send: (message: object) => void }} options
 * @returns {{ receive(message: object): Promise<void>, close(): void }}
 */
export function createMcpServer({ io, send }) {
  const state = {
    legacy: null, // { version, capabilities } after `initialize`
    quotes: new Map(),
    pending: new Map(),
    nextId: 1,
    stateKey: crypto.randomBytes(32),
  };

  /** A request from the server to the client (legacy elicitation). Resolves with its result. */
  function requestClient(method, params) {
    const id = `cheapgen-${state.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`no answer to ${method}`));
      }, CLIENT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      state.pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  const ctx = { io, state, requestClient };

  async function dispatch(msg) {
    const params = msg.params ?? {};
    const meta = params._meta ?? {};
    const modern = meta[META.version] !== undefined;
    if (modern && !SUPPORTED.includes(meta[META.version])) {
      throw new RpcError(-32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: meta[META.version] });
    }
    const call = {
      modern,
      capabilities: modern ? (meta[META.capabilities] ?? {}) : (state.legacy?.capabilities ?? {}),
      legacyVersion: modern ? null : (state.legacy?.version ?? null),
    };
    let result;
    switch (msg.method) {
      case 'initialize': {
        const version = LEGACY.includes(params.protocolVersion) ? params.protocolVersion : LEGACY[0];
        state.legacy = { version, capabilities: params.capabilities ?? {} };
        return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: serverInfo(), instructions: INSTRUCTIONS };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        result = {};
        break;
      case 'server/discover':
        result = { supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: INSTRUCTIONS };
        break;
      case 'tools/list':
        result = { tools: TOOL_DEFINITIONS };
        if (modern) Object.assign(result, { ttlMs: 3_600_000, cacheScope: 'private' });
        break;
      case 'tools/call':
        result = await callTool(ctx, params, call);
        break;
      default:
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
    if (modern || msg.method === 'server/discover') {
      result = { resultType: 'complete', ...result, _meta: { ...(result._meta ?? {}), [META.serverInfo]: serverInfo() } };
    }
    return result;
  }

  async function receive(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    // A reply to one of our own requests.
    if (msg.method === undefined && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      const p = state.pending.get(msg.id);
      if (!p) return;
      state.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new Error(msg.error?.message ?? 'client error'));
      else p.resolve(msg.result);
      return;
    }
    const isNotification = msg.id === undefined;
    try {
      if (typeof msg.method !== 'string') throw new RpcError(-32600, 'Invalid request');
      const result = await dispatch(msg);
      if (!isNotification && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      if (isNotification) return;
      const code = err instanceof RpcError ? err.rpcCode : -32603;
      const message = err instanceof RpcError ? err.message : `Internal error: ${err?.message ?? err}`;
      send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message, ...(err?.data ? { data: err.data } : {}) } });
    }
  }

  /** Ends any wait for the client, e.g. when its input closes. */
  function close() {
    for (const [id, p] of state.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('connection closed'));
      state.pending.delete(id);
    }
  }

  return { receive, close };
}
