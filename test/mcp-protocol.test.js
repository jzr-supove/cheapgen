// MCP server: JSON-RPC handling for both protocol styles (initialize handshake and the stateless
// per-request style), unknown methods, bad input, and the stdio framing of `cheapgen mcp`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp, runStdio, line, META, MODERN, LEGACY, PKG_VERSION } from './helpers/mcp.js';

describe('legacy handshake', () => {
  test('initialize echoes a supported version and advertises tools and the server identity', async (t) => {
    const h = await startMcp(t);
    const reply = await h.raw('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.protocolVersion, '2025-06-18');
    assert.ok(reply.result.capabilities.tools, 'tools capability');
    assert.equal(reply.result.serverInfo.name, 'cheapgen');
    assert.equal(reply.result.serverInfo.version, PKG_VERSION);
  });

  test('an unsupported legacy version is answered with the newest legacy version', async (t) => {
    const h = await startMcp(t);
    const reply = await h.raw('initialize', { protocolVersion: '2024-01-01', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
    assert.equal(reply.result.protocolVersion, LEGACY);
  });

  test('the initialized notification gets no reply', async (t) => {
    const h = await startMcp(t);
    await h.raw('initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'c', version: '1' } });
    const before = h.sent.length;
    await h.notify('notifications/initialized');
    assert.equal(h.sent.length, before);
  });

  test('ping answers an empty result, and the reply carries the request id', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const reply = await h.request('ping');
    assert.deepEqual(reply.result, {});
    assert.equal(reply.id, h.sent.at(-1).id);
  });

  test('tools/list works after the handshake and carries no modern-only fields', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const reply = await h.request('tools/list');
    assert.ok(Array.isArray(reply.result.tools));
    assert.equal(reply.result.resultType, undefined);
  });
});

describe('stateless (2026-07-28) requests', () => {
  const meta = (extra = {}) => ({
    [META.version]: MODERN,
    [META.clientInfo]: { name: 'c', version: '1' },
    [META.caps]: {},
    ...extra,
  });

  test('tools/list works without any initialize and says how long it may be cached', async (t) => {
    const h = await startMcp(t);
    const reply = await h.raw('tools/list', { _meta: meta() });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.equal(reply.result.resultType, 'complete');
    assert.equal(reply.result._meta[META.server].name, 'cheapgen');
    assert.equal(reply.result._meta[META.server].version, PKG_VERSION);
    assert.equal(typeof reply.result.ttlMs, 'number');
    assert.ok(reply.result.ttlMs >= 0);
    assert.equal(typeof reply.result.cacheScope, 'string');
    assert.ok(reply.result.tools.length > 0);
  });

  test('every modern result is marked complete and names the server', async (t) => {
    const h = await startMcp(t);
    const reply = await h.raw('ping', { _meta: meta() });
    assert.equal(reply.result.resultType, 'complete');
    assert.equal(reply.result._meta[META.server].name, 'cheapgen');
  });

  test('an unsupported protocol version is error -32022 listing what is supported', async (t) => {
    const h = await startMcp(t);
    const reply = await h.raw('tools/list', { _meta: meta({ [META.version]: '1900-01-01' }) });
    assert.equal(reply.result, undefined);
    assert.equal(reply.error.code, -32022);
    assert.ok(reply.error.data.supported.includes(MODERN));
    assert.ok(reply.error.data.supported.includes(LEGACY));
    assert.equal(reply.error.data.requested, '1900-01-01');
  });
});

describe('server/discover', () => {
  test('lists the supported versions, capabilities and server info', async (t) => {
    const h = await startMcp(t);
    const reply = await h.raw('server/discover', {});
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.equal(reply.result.resultType, 'complete');
    assert.ok(reply.result.supportedVersions.includes(MODERN));
    assert.ok(reply.result.supportedVersions.includes(LEGACY));
    assert.ok(reply.result.capabilities.tools);
    assert.equal(reply.result._meta[META.server].name, 'cheapgen');
  });

  test('also answers a request that carries modern metadata', async (t) => {
    const h = await startMcp(t);
    const reply = await h.raw('server/discover', { _meta: { [META.version]: MODERN, [META.clientInfo]: { name: 'c', version: '1' }, [META.caps]: {} } });
    assert.ok(reply.result.supportedVersions.includes(MODERN));
  });
});

describe('bad requests', () => {
  test('an unknown method is -32601 and keeps the id', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const reply = await h.request('does/not/exist');
    assert.equal(reply.error.code, -32601);
    assert.equal(reply.result, undefined);
  });

  test('an unknown method in the stateless style is -32601 too', async (t) => {
    const h = await startMcp(t);
    h.useModern();
    assert.equal((await h.request('does/not/exist')).error.code, -32601);
  });

  test('a notification of an unknown method gets no reply', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const before = h.sent.length;
    await h.notify('notifications/does-not-exist', {});
    assert.equal(h.sent.length, before);
  });

  test('calling an unknown tool is invalid params (-32602)', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const reply = await h.callRaw('no_such_tool', {});
    assert.equal(reply.error.code, -32602);
    assert.equal(h.e.calls.length, 0);
  });

  test('tools/call without a tool name is invalid params (-32602)', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const reply = await h.request('tools/call', { arguments: {} });
    assert.equal(reply.error.code, -32602);
  });
});

describe('cheapgen mcp over stdio', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'c', version: '1' } } };
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

  test('answers one line per message and exits 0 when the input ends', async (t) => {
    const r = await runStdio(t, [line(init), line({ jsonrpc: '2.0', method: 'notifications/initialized' }), line(list)]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.messages.map((m) => m.id), [1, 2], 'one reply per request, none for the notification');
    assert.equal(r.messages[0].result.serverInfo.name, 'cheapgen');
    assert.ok(r.messages[1].result.tools.length > 0);
    assert.equal(r.e.calls.length, 0, 'no network');
  });

  test('a message split across chunks is handled once complete', async (t) => {
    const text = line(list);
    const cut = Math.floor(text.length / 2);
    const r = await runStdio(t, [text.slice(0, cut), text.slice(cut)]);
    assert.equal(r.code, 0);
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].id, 2);
  });

  test('several messages in one chunk are all handled, in order', async (t) => {
    const r = await runStdio(t, [line(init) + line(list) + line({ jsonrpc: '2.0', id: 3, method: 'ping' })]);
    assert.deepEqual(r.messages.map((m) => m.id), [1, 2, 3]);
  });

  test('Buffer chunks work, including a multi-byte character cut in the middle', async (t) => {
    const msg = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'no_such_tool', arguments: { note: 'café über' } } };
    const bytes = Buffer.from(line(msg), 'utf8');
    const at = bytes.indexOf(Buffer.from('é', 'utf8')) + 1; // between the two bytes of the character
    const r = await runStdio(t, [bytes.subarray(0, at), bytes.subarray(at)]);
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].id, 7);
    assert.equal(r.messages[0].error.code, -32602, 'the line was parsed as valid JSON');
  });

  test('a malformed line is -32700 with a null id, and the server keeps going', async (t) => {
    const r = await runStdio(t, [line(init), '{this is not json\n', line(list)]);
    assert.equal(r.code, 0);
    assert.equal(r.messages.length, 3);
    assert.equal(r.messages[1].error.code, -32700);
    assert.equal(r.messages[1].id, null);
    assert.equal(r.messages[2].id, 2);
    assert.ok(r.messages[2].result.tools);
  });

  test('blank lines are ignored', async (t) => {
    const r = await runStdio(t, ['\n\n', line(list), '\n']);
    assert.equal(r.messages.length, 1);
  });

  test('a final message without a trailing newline is still handled', async (t) => {
    const r = await runStdio(t, [JSON.stringify(list)]);
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].id, 2);
  });

  test('nothing but JSON-RPC lines reaches stdout (CRLF input too)', async (t) => {
    const r = await runStdio(t, [`${JSON.stringify(init)}\r\n`, `${JSON.stringify(list)}\r\n`]);
    assert.equal(r.messages.length, 2);
    for (const m of r.messages) assert.equal(m.jsonrpc, '2.0');
  });

  test('stateless requests work over stdio without a handshake', async (t) => {
    const r = await runStdio(t, [line({ jsonrpc: '2.0', id: 1, method: 'tools/list',
      params: { _meta: { [META.version]: MODERN, [META.clientInfo]: { name: 'c', version: '1' }, [META.caps]: {} } } })]);
    assert.equal(r.messages[0].result.resultType, 'complete');
  });

  test('empty input exits 0 with no output', async (t) => {
    const r = await runStdio(t, []);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });
});
