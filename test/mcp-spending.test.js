// MCP spending safety: `run` takes only a quoteId; the cost limit stays on the server; above the
// limit a person must accept an elicitation; an unknown outcome uses the quote up for good; and
// no API key reaches any message.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli/main.js';
import { createEnvironment, keysFor, approx } from './helpers/harness.js';
import { routesFor, submitCalls } from './helpers/providers.js';
import { startMcp, buildIo, line, LEGACY } from './helpers/mcp.js';

const PROMPT = 'a calm lake at dawn';
const MINI = { model: 'seedance-2.0-mini', prompt: PROMPT, resolution: '480p', duration: 5 };     // kie 0.095
const BIG = { model: 'seedance-2.0', prompt: PROMPT, resolution: '720p', duration: 15 };           // kie 3.075, limit is 1.00
const ELICIT = { elicitation: {} };

const kieEnv = (extra = {}) => ({ env: keysFor('kie'), routes: routesFor({ kie: {} }), ...extra });
const errorCode = (result) => result.structuredContent?.error?.code;

/** The reply is a refusal: a JSON-RPC error or a tool error, and never a finished job. */
function assertRefused(reply) {
  if (reply.error) return;
  assert.equal(reply.result.isError, true, `expected a refusal, got ${JSON.stringify(reply.result)}`);
}

describe('run needs a valid quote', () => {
  test('an unknown quoteId is refused as quote_expired and nothing is submitted', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const r = await h.call('run', { quoteId: 'no-such-quote' });
    assert.equal(r.isError, true);
    assert.equal(errorCode(r), 'quote_expired');
    assert.equal(h.e.calls.length, 0, 'not even a price lookup');
    assert.equal(h.e.spendLines().length, 0);
  });

  test('a quote older than ten minutes is refused as quote_expired', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const q = await h.quote(MINI);
    h.e.clock.ms += 10 * 60_000 + 1000;
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.equal(r.isError, true);
    assert.equal(errorCode(r), 'quote_expired');
    assert.equal(h.submits(), 0);
  });

  test('a quote is still good after nine minutes', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const q = await h.quote(MINI);
    h.e.clock.ms += 9 * 60_000;
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(h.submits(), 1);
  });

  test('a quote made without a prompt is refused as needs_prompt', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const { prompt, ...noPrompt } = MINI;
    const q = await h.quote(noPrompt);
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.equal(r.isError, true);
    assert.equal(errorCode(r), 'needs_prompt');
    assert.equal(h.submits(), 0);
    assert.equal(h.e.spendLines().length, 0);
  });

  test('a quote from another server process is unknown', async (t) => {
    const first = await startMcp(t, kieEnv());
    await first.useLegacy();
    const q = await first.quote(MINI);
    const second = await startMcp(t, kieEnv());
    await second.useLegacy();
    const r = await second.call('run', { quoteId: q.quoteId });
    assert.equal(errorCode(r), 'quote_expired');
    assert.equal(second.submits(), 0);
  });
});

describe('run within the limit', () => {
  test('submits exactly once with the quoted request and returns the job id', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const q = await h.quote(MINI);
    assert.equal(h.submits(), 0, 'quoting submits nothing');
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(h.submits(), 1);
    assert.match(r.structuredContent.job, /^kie:\S+/);
    assert.equal(r.structuredContent.state, 'submitted');
    assert.equal(r.structuredContent.model, 'seedance-2.0-mini');
    approx(r.structuredContent.estimateUsd, 0.095);

    const sent = submitCalls(h.e.calls, 'kie')[0].body;
    assert.ok(JSON.stringify(sent).includes(PROMPT), 'the prompt from the quote was sent');
    assert.ok(JSON.stringify(sent).includes('480p'));
    assert.equal(h.e.spendLines().filter((l) => l.event === 'submitted').length, 1);
  });

  test('it does not wait for the job: only the submit is made, no status polling', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const q = await h.quote(MINI);
    await h.call('run', { quoteId: q.quoteId });
    assert.equal(h.e.calls.filter((c) => /recordInfo/.test(c.url)).length, 0);
  });

  test('the same quoteId again is refused as quote_used and submits nothing more', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const q = await h.quote(MINI);
    assert.notEqual((await h.call('run', { quoteId: q.quoteId })).isError, true);
    const again = await h.call('run', { quoteId: q.quoteId });
    assert.equal(again.isError, true);
    assert.equal(errorCode(again), 'quote_used');
    assert.equal(h.submits(), 1);
    assert.equal(h.e.spendLines().filter((l) => l.event === 'submitted').length, 1);
  });

  test('a second quote for the same request is a separate purchase', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy();
    const a = await h.quote(MINI);
    const b = await h.quote(MINI);
    assert.notEqual((await h.call('run', { quoteId: a.quoteId })).isError, true);
    assert.notEqual((await h.call('run', { quoteId: b.quoteId })).isError, true);
    assert.equal(h.submits(), 2);
  });

  test('a limit raised in config lets a bigger run through without asking', async (t) => {
    const h = await startMcp(t, kieEnv({ userConfig: { maxCostPerRun: 5 } }));
    await h.useLegacy();
    const q = await h.quote(BIG);
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(h.submits(), 1);
    assert.equal(h.sent.filter((m) => m.method === 'elicitation/create').length, 0);
  });
});

describe('the price moved after the quote', () => {
  // WaveSpeed asks its live price endpoint on every lookup, so the test controls the price.
  const wavespeed = (t, price) => startMcp(t, {
    env: keysFor('wavespeed'),
    routes: routesFor({ wavespeed: { live: { responses: [() => ({ status: 200,
      json: { code: 200, message: 'success', data: { price: price.now, discounted_price: price.now, currency: 'USD' } } })] } } }),
  });

  test('a higher price at run time is refused as price_changed and nothing is submitted', async (t) => {
    const price = { now: 0.05 };
    const h = await wavespeed(t, price);
    await h.useLegacy();
    const q = await h.quote(MINI);
    approx(q.quotes.find((x) => x.provider === 'wavespeed').usd, 0.05);
    price.now = 0.08;
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.equal(r.isError, true);
    assert.equal(errorCode(r), 'price_changed');
    assert.match(r.structuredContent.error.message, /quote/i, 'tells the agent to quote again');
    assert.equal(h.submits(), 0);
    assert.equal(h.e.spendLines().length, 0);
  });

  test('after price_changed a fresh quote at the new price can be run', async (t) => {
    const price = { now: 0.05 };
    const h = await wavespeed(t, price);
    await h.useLegacy();
    const old = await h.quote(MINI);
    price.now = 0.08;
    assert.equal(errorCode(await h.call('run', { quoteId: old.quoteId })), 'price_changed');
    const fresh = await h.quote(MINI);
    const r = await h.call('run', { quoteId: fresh.quoteId });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(h.submits(), 1);
  });

  test('a lower price at run time still goes ahead', async (t) => {
    const price = { now: 0.08 };
    const h = await wavespeed(t, price);
    await h.useLegacy();
    const q = await h.quote(MINI);
    price.now = 0.05;
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(h.submits(), 1);
  });
});

describe('over the limit, client cannot be asked', () => {
  for (const era of ['legacy', 'modern']) {
    test(`${era} client without elicitation: over_limit, nothing submitted, names maxCostPerRun`, async (t) => {
      const h = await startMcp(t, kieEnv());
      if (era === 'legacy') await h.useLegacy({}); else h.useModern({});
      const q = await h.quote(BIG);
      const r = await h.call('run', { quoteId: q.quoteId });
      assert.equal(r.isError, true);
      assert.equal(errorCode(r), 'over_limit');
      assert.match(r.structuredContent.error.message, /maxCostPerRun/);
      assert.equal(h.submits(), 0);
      assert.equal(h.e.spendLines().length, 0);
      assert.equal(h.sent.filter((m) => m.method === 'elicitation/create').length, 0, 'no question to a client that cannot answer');
    });
  }

  test('a legacy client that only supports other capabilities (sampling, roots) cannot go over either', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy({ sampling: {}, roots: {} });
    const q = await h.quote(BIG);
    assert.equal(errorCode(await h.call('run', { quoteId: q.quoteId })), 'over_limit');
    assert.equal(h.submits(), 0);
  });

  test('a client with no handshake at all cannot go over', async (t) => {
    const h = await startMcp(t, kieEnv());
    const q = (await h.raw('tools/call', { name: 'quote', arguments: BIG })).result.structuredContent;
    const r = await h.raw('tools/call', { name: 'run', arguments: { quoteId: q.quoteId } });
    assert.ok(r.error || r.result.isError);
    assert.equal(h.submits(), 0);
  });

  test('an unknown price needs confirmation too: price_unknown without elicitation', async (t) => {
    // WaveSpeed has no price on record for seedance-2.5-flash, and its live price lookup is down.
    const h = await startMcp(t, { env: keysFor('wavespeed'), routes: routesFor({ wavespeed: {} }) });
    await h.useLegacy({});
    const q = await h.quote({ model: 'seedance-2.5-flash', prompt: PROMPT, resolution: '480p' });
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.equal(r.isError, true);
    assert.equal(errorCode(r), 'price_unknown');
    assert.equal(h.submits(), 0);
  });

  test('an over-limit refusal does not use the quote up', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy({});
    const q = await h.quote(BIG);
    assert.equal(errorCode(await h.call('run', { quoteId: q.quoteId })), 'over_limit');
    assert.equal(errorCode(await h.call('run', { quoteId: q.quoteId })), 'over_limit', 'still over_limit, not quote_used');
  });
});

describe('over the limit, stateless client that supports elicitation', () => {
  const retry = (h, quoteId, state, response, extra = {}) =>
    h.callRaw('run', { quoteId }, { requestState: state, inputResponses: { confirm_spend: response }, ...extra });
  const accept = { action: 'accept', content: { confirm: true } };

  async function ask(t, setup = kieEnv()) {
    const h = await startMcp(t, setup);
    h.useModern(ELICIT);
    const q = await h.quote(BIG);
    const r = await h.call('run', { quoteId: q.quoteId });
    return { h, q, r };
  }

  test('the first call asks for confirmation and submits nothing', async (t) => {
    const { h, r } = await ask(t);
    assert.equal(r.resultType, 'input_required');
    const req = r.inputRequests.confirm_spend;
    assert.equal(req.method, 'elicitation/create');
    assert.equal(req.params.mode, 'form');
    assert.match(req.params.message, /\$3\.07\d/, 'the message states the price');
    assert.match(req.params.message, /kie/i, 'and the provider');
    assert.equal(req.params.requestedSchema.properties.confirm.type, 'boolean');
    assert.ok(req.params.requestedSchema.required.includes('confirm'));
    assert.equal(typeof r.requestState, 'string');
    assert.ok(r.requestState.length > 16);
    assert.notEqual(r.isError, true);
    assert.equal(h.submits(), 0);
    assert.equal(h.e.spendLines().length, 0);
  });

  test('the question is not repeated with the same state for a different quote', async (t) => {
    const { h, r } = await ask(t);
    const other = await h.quote(BIG);
    const r2 = await h.call('run', { quoteId: other.quoteId });
    assert.notEqual(r2.requestState, r.requestState);
  });

  test('retrying with accept and the same state submits once, at the confirmed price', async (t) => {
    const { h, q, r } = await ask(t);
    const done = await retry(h, q.quoteId, r.requestState, accept);
    assert.ok(done.result, JSON.stringify(done));
    assert.notEqual(done.result.isError, true, JSON.stringify(done.result));
    assert.equal(done.result.resultType, 'complete');
    assert.match(done.result.structuredContent.job, /^kie:/);
    assert.equal(h.submits(), 1);
    approx(h.e.spendLines().find((l) => l.event === 'submitted').estimateUsd, 3.075);
  });

  test('the quote is used up after an accepted run', async (t) => {
    const { h, q, r } = await ask(t);
    await retry(h, q.quoteId, r.requestState, accept);
    const again = await retry(h, q.quoteId, r.requestState, accept);
    assert.equal(h.submits(), 1);
    assertRefused(again);
    if (again.result) assert.equal(errorCode(again.result), 'quote_used');
  });

  for (const [name, response] of [
    ['decline', { action: 'decline' }],
    ['cancel', { action: 'cancel' }],
    ['accept with confirm false', { action: 'accept', content: { confirm: false } }],
    ['accept with no content', { action: 'accept' }],
    ['accept with confirm as a string', { action: 'accept', content: { confirm: 'true' } }],
  ]) {
    test(`${name} is declined and nothing is submitted`, async (t) => {
      const { h, q, r } = await ask(t);
      const done = await retry(h, q.quoteId, r.requestState, response);
      assert.equal(done.result.isError, true, JSON.stringify(done));
      assert.equal(errorCode(done.result), 'declined');
      assert.equal(h.submits(), 0);
      assert.equal(h.e.spendLines().length, 0);
    });
  }

  test('after a decline the quote can still be run if the person is asked again and accepts', async (t) => {
    const { h, q, r } = await ask(t);
    await retry(h, q.quoteId, r.requestState, { action: 'decline' });
    const second = await h.call('run', { quoteId: q.quoteId });
    assert.equal(second.resultType, 'input_required');
    const done = await retry(h, q.quoteId, second.requestState, accept);
    assert.notEqual(done.result.isError, true, JSON.stringify(done));
    assert.equal(h.submits(), 1);
  });

  test('a tampered state is rejected (last character, first character, truncated)', async (t) => {
    const { h, q, r } = await ask(t);
    const s = r.requestState;
    const flip = (c) => (c === 'A' ? 'B' : 'A');
    for (const bad of [s.slice(0, -1) + flip(s.at(-1)), flip(s[0]) + s.slice(1), s.slice(0, s.length - 8), 'garbage', '']) {
      assertRefused(await retry(h, q.quoteId, bad, accept));
    }
    assert.equal(h.submits(), 0);
  });

  test('an accept without any state is rejected', async (t) => {
    const { h, q } = await ask(t);
    assertRefused(await h.callRaw('run', { quoteId: q.quoteId }, { inputResponses: { confirm_spend: accept } }));
    assert.equal(h.submits(), 0);
  });

  test('a state issued for one quote cannot confirm another', async (t) => {
    const { h, r } = await ask(t);
    const other = await h.quote(BIG);
    assertRefused(await retry(h, other.quoteId, r.requestState, accept));
    assert.equal(h.submits(), 0);
  });

  test('a state older than five minutes is rejected', async (t) => {
    const { h, q, r } = await ask(t);
    h.e.clock.ms += 5 * 60_000 + 1000;
    assertRefused(await retry(h, q.quoteId, r.requestState, accept));
    assert.equal(h.submits(), 0);
  });

  test('a state from another server process is rejected', async (t) => {
    const { q, r } = await ask(t);
    const other = await startMcp(t, kieEnv());
    other.useModern(ELICIT);
    const q2 = await other.quote(BIG);
    assertRefused(await retry(other, q2.quoteId, r.requestState, accept));
    assertRefused(await retry(other, q.quoteId, r.requestState, accept));
    assert.equal(other.submits(), 0);
  });

  test('if the price rises while the person decides, the run is refused', async (t) => {
    const price = { now: 0.05 };
    const h = await startMcp(t, { env: keysFor('wavespeed'), userConfig: { maxCostPerRun: 0.04 },
      routes: routesFor({ wavespeed: { live: { responses: [() => ({ status: 200,
        json: { code: 200, message: 'success', data: { price: price.now, discounted_price: price.now, currency: 'USD' } } })] } } }) });
    h.useModern(ELICIT);
    const q = await h.quote(MINI);
    const first = await h.call('run', { quoteId: q.quoteId });
    assert.equal(first.resultType, 'input_required');
    price.now = 0.09;
    const done = await retry(h, q.quoteId, first.requestState, accept);
    assertRefused(done);
    if (done.result) assert.equal(errorCode(done.result), 'price_changed');
    assert.equal(h.submits(), 0);
  });

  test('an unknown price asks too, and accepting runs it', async (t) => {
    const h = await startMcp(t, { env: keysFor('wavespeed'), routes: routesFor({ wavespeed: {} }) });
    h.useModern(ELICIT);
    const q = await h.quote({ model: 'seedance-2.5-flash', prompt: PROMPT, resolution: '480p' });
    const first = await h.call('run', { quoteId: q.quoteId });
    assert.equal(first.resultType, 'input_required');
    assert.match(first.inputRequests.confirm_spend.params.message, /unknown|not known|no price/i);
    assert.equal(h.submits(), 0);
    const done = await retry(h, q.quoteId, first.requestState, accept);
    assert.notEqual(done.result.isError, true, JSON.stringify(done));
    assert.equal(h.submits(), 1);
  });
});

describe('over the limit, legacy client that supports elicitation', () => {
  const startCall = (h, quoteId, id = 900) =>
    h.server.receive({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run', arguments: { quoteId } } });
  const isAsk = (m) => m.method === 'elicitation/create';

  for (const version of [LEGACY, '2025-06-18']) {
    test(`${version}: the server asks, and an accept from the person submits once`, async (t) => {
      const h = await startMcp(t, kieEnv());
      await h.useLegacy(ELICIT, version);
      const q = await h.quote(BIG);
      const pending = startCall(h, q.quoteId);
      const ask = await h.waitForSent(isAsk, 'an elicitation request');
      assert.equal(ask.jsonrpc, '2.0');
      assert.ok(ask.id !== undefined && ask.id !== null);
      assert.match(ask.params.message, /\$3\.07\d/);
      assert.equal(ask.params.requestedSchema.properties.confirm.type, 'boolean');
      if (version === LEGACY) assert.equal(ask.params.mode, 'form');
      assert.equal(h.submits(), 0, 'nothing is sent while the person decides');
      assert.equal(h.replyFor(900), undefined, 'the tool call has not answered yet');

      await h.server.receive({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: { confirm: true } } });
      await pending;
      const reply = h.replyFor(900);
      assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
      assert.match(reply.result.structuredContent.job, /^kie:/);
      assert.equal(h.submits(), 1);
    });
  }

  for (const [name, response] of [
    ['decline', { action: 'decline' }],
    ['cancel', { action: 'cancel' }],
    ['accept with confirm false', { action: 'accept', content: { confirm: false } }],
    ['an error reply', null],
  ]) {
    test(`${name} is declined and nothing is submitted`, async (t) => {
      const h = await startMcp(t, kieEnv());
      await h.useLegacy(ELICIT);
      const q = await h.quote(BIG);
      const pending = startCall(h, q.quoteId);
      const ask = await h.waitForSent(isAsk);
      await h.server.receive(response
        ? { jsonrpc: '2.0', id: ask.id, result: response }
        : { jsonrpc: '2.0', id: ask.id, error: { code: -32601, message: 'elicitation not supported' } });
      await pending;
      const reply = h.replyFor(900);
      assert.equal(reply.result.isError, true);
      assert.equal(errorCode(reply.result), 'declined');
      assert.equal(h.submits(), 0);
    });
  }

  test('an answer to some other request id does not confirm the spend', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy(ELICIT);
    const q = await h.quote(BIG);
    const pending = startCall(h, q.quoteId);
    const ask = await h.waitForSent(isAsk);
    await h.server.receive({ jsonrpc: '2.0', id: 'not-the-servers-id', result: { action: 'accept', content: { confirm: true } } });
    await h.server.receive({ jsonrpc: '2.0', id: 123456, result: { action: 'accept', content: { confirm: true } } });
    assert.equal(h.submits(), 0);
    assert.equal(h.replyFor(900), undefined, 'still waiting for the real answer');
    await h.server.receive({ jsonrpc: '2.0', id: ask.id, result: { action: 'decline' } });
    await pending;
    assert.equal(errorCode(h.replyFor(900).result), 'declined');
    assert.equal(h.submits(), 0);
  });

  test('the server never sends a question before the call, or when the run is within the limit', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy(ELICIT);
    const q = await h.quote(MINI);
    await h.call('run', { quoteId: q.quoteId });
    assert.equal(h.sent.filter(isAsk).length, 0);
    assert.equal(h.submits(), 1);
  });

  test('after a decline the same quote can be asked again', async (t) => {
    const h = await startMcp(t, kieEnv());
    await h.useLegacy(ELICIT);
    const q = await h.quote(BIG);
    let pending = startCall(h, q.quoteId, 901);
    const first = await h.waitForSent(isAsk);
    await h.server.receive({ jsonrpc: '2.0', id: first.id, result: { action: 'decline' } });
    await pending;
    pending = startCall(h, q.quoteId, 902);
    const second = await h.waitForSent((m) => isAsk(m) && m.id !== first.id);
    await h.server.receive({ jsonrpc: '2.0', id: second.id, result: { action: 'accept', content: { confirm: true } } });
    await pending;
    assert.notEqual(h.replyFor(902).result.isError, true);
    assert.equal(h.submits(), 1);
  });
});

describe('unknown outcome', () => {
  const timeoutEnv = () => ({ env: keysFor('kie'), routes: routesFor({ kie: { submit: 'timeout' } }) });

  test('is reported as unknown_outcome, and the quote cannot be run again', async (t) => {
    const h = await startMcp(t, timeoutEnv());
    await h.useLegacy();
    const q = await h.quote(MINI);
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.equal(r.isError, true);
    assert.equal(errorCode(r), 'unknown_outcome');
    assert.equal(h.submits(), 1);
    const again = await h.call('run', { quoteId: q.quoteId });
    assert.equal(again.isError, true);
    assert.equal(errorCode(again), 'quote_used');
    assert.equal(h.submits(), 1, 'the POST is never retried');
  });

  test('also after a confirmed over-limit run', async (t) => {
    const h = await startMcp(t, timeoutEnv());
    h.useModern(ELICIT);
    const q = await h.quote(BIG);
    const first = await h.call('run', { quoteId: q.quoteId });
    const done = await h.callRaw('run', { quoteId: q.quoteId }, { requestState: first.requestState,
      inputResponses: { confirm_spend: { action: 'accept', content: { confirm: true } } } });
    assert.equal(errorCode(done.result), 'unknown_outcome');
    assert.equal(h.submits(), 1);
    const replay = await h.callRaw('run', { quoteId: q.quoteId }, { requestState: first.requestState,
      inputResponses: { confirm_spend: { action: 'accept', content: { confirm: true } } } });
    assertRefused(replay);
    assert.equal(h.submits(), 1);
  });

  test('a rejection by the first provider falls back, and the quote is spent after one accepted job', async (t) => {
    // Kie rejects, Replicate takes it: still exactly one accepted job, and the quote is spent.
    const h = await startMcp(t, { env: keysFor('kie', 'replicate'), routes: routesFor({ kie: { submit: 'unauthorized' }, replicate: {} }) });
    await h.useLegacy();
    const q = await h.quote(MINI);
    const r = await h.call('run', { quoteId: q.quoteId });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.match(r.structuredContent.job, /^replicate:/);
    assert.equal(h.e.spendLines().filter((l) => l.event === 'submitted').length, 1);
    assert.equal(errorCode(await h.call('run', { quoteId: q.quoteId })), 'quote_used');
  });
});

describe('API keys never appear in MCP output', () => {
  const KEY = 'KIE-SECRET-k1e9Zq7x';
  const echo = (status) => (req) => ({ status, json: { code: status, msg: `Invalid credentials ${req.headers.authorization ?? ''}`, data: null } });
  const parts = (key) => [key, ...key.split(/[:\-_]/).filter((p) => p.length >= 8)];

  function assertNoKey(text, label) {
    for (const p of parts(KEY)) assert.ok(!text.includes(p), `${label}: ${p} leaked`);
  }

  test('across a quote, a run that the provider rejects with the key echoed, a status error and a network error', async (t) => {
    const routes = routesFor({ kie: { submit: echo(401) } });
    routes.unshift({ method: 'GET', url: 'https://api.kie.ai/api/v1/jobs/recordInfo', responses: [echo(401)] });
    const h = await startMcp(t, { env: { KIE_API_KEY: KEY }, routes });
    await h.useLegacy();

    const q = await h.quote(MINI);
    const run = await h.call('run', { quoteId: q.quoteId });
    assert.equal(run.isError, true, 'the rejection is reported');
    await h.call('job_status', { job: 'kie:task_kie_001' });
    await h.call('wait_job', { job: 'kie:task_kie_001', timeoutSeconds: 1 });
    await h.call('providers', {});
    await h.callRaw('quote', { model: 'seedance-2.0-mini', apiKey: KEY });
    assert.ok(h.e.calls.some((c) => JSON.stringify(c.headers).includes(KEY)), 'the key was really used');

    // And a transport error whose message carries the key.
    h.e.setRoutes(routesFor({ kie: { submit: () => ({ error: new TypeError(`connect failed for ${KEY}`) }) } }));
    const q2 = await h.quote(MINI);
    const unknown = await h.call('run', { quoteId: q2.quoteId });
    assert.equal(errorCode(unknown), 'unknown_outcome');

    assertNoKey(h.allSent(), 'messages');
    assertNoKey(h.out.stdout + h.out.stderr, 'io output');
    assertNoKey(h.e.spendText(), 'spend log');
  });

  test('over stdio, stdout and stderr never contain the key', async (t) => {
    const e = createEnvironment(t, { env: { KIE_API_KEY: KEY }, routes: routesFor({ kie: { submit: echo(401) } }) });
    const { io, out } = buildIo(e);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'c', version: '1' } } };
    const quote = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quote', arguments: MINI } };
    const seen = () => out.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    io.mcpInput = (async function* input() {
      yield line(init);
      yield line(quote);
      for (let i = 0; i < 5000 && !seen().some((m) => m.id === 2); i += 1) await new Promise((r) => setImmediate(r));
      const quoteId = seen().find((m) => m.id === 2).result.structuredContent.quoteId;
      yield line({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run', arguments: { quoteId } } });
    }());
    const code = await main(['mcp'], io);
    assert.equal(code, 0);
    const run = seen().find((m) => m.id === 3);
    assert.equal(run.result.isError, true);
    assert.ok(e.calls.some((c) => JSON.stringify(c.headers).includes(KEY)), 'the key was really used');
    assertNoKey(out.stdout, 'stdout');
    assertNoKey(out.stderr, 'stderr');
  });
});
