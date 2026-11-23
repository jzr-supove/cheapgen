// MCP tools: the list and its schemas, and that each tool returns what the matching CLI command
// prints with --json.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from '../src/catalog.js';
import { keysFor, quoteArgs, runArgs } from './helpers/harness.js';
import { routesFor } from './helpers/providers.js';
import { startMcp, TOOL_NAMES } from './helpers/mcp.js';

const MINI = { model: 'seedance-2.0-mini', prompt: 'a calm lake at dawn', resolution: '480p', duration: 5 };
const READ_ONLY = TOOL_NAMES.filter((n) => n !== 'run');

const toolsOf = async (h) => (await h.request('tools/list')).result.tools;
const parsedText = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

/** Property names anywhere inside a JSON schema. */
function propertyNames(schema, out = []) {
  if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'properties' && v && typeof v === 'object') out.push(...Object.keys(v));
      propertyNames(v, out);
    }
  }
  return out;
}

describe('tools/list', () => {
  for (const era of ['legacy', 'modern']) {
    test(`${era}: exactly the seven tools in a fixed order`, async (t) => {
      const h = await startMcp(t);
      if (era === 'legacy') await h.useLegacy(); else h.useModern();
      const tools = await toolsOf(h);
      assert.deepEqual(tools.map((x) => x.name), TOOL_NAMES);
      const again = await toolsOf(h);
      assert.deepEqual(again.map((x) => x.name), TOOL_NAMES, 'the order is stable');
    });
  }

  test('every tool has a description and a closed object input schema', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    for (const tool of await toolsOf(h)) {
      assert.equal(typeof tool.description, 'string', tool.name);
      assert.ok(tool.description.length > 20, `${tool.name} describes itself`);
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown arguments`);
    }
  });

  test('read-only tools are annotated read-only', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const byName = Object.fromEntries((await toolsOf(h)).map((x) => [x.name, x]));
    for (const n of READ_ONLY) assert.equal(byName[n].annotations?.readOnlyHint, true, n);
  });

  test('run is annotated as a destructive, open-world write and warns that it spends money', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const run = (await toolsOf(h)).find((x) => x.name === 'run');
    assert.equal(run.annotations.readOnlyHint, false);
    assert.equal(run.annotations.destructiveHint, true);
    assert.equal(run.annotations.openWorldHint, true);
    assert.match(run.description, /spend|money|charge|cost/i);
    assert.match(run.description, /money|\$|USD|credits/i);
  });

  test('run takes only a quoteId', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const run = (await toolsOf(h)).find((x) => x.name === 'run');
    assert.deepEqual(Object.keys(run.inputSchema.properties), ['quoteId']);
    assert.deepEqual(run.inputSchema.required, ['quoteId']);
  });

  test('quote takes the request parameters and requires the model', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const quote = (await toolsOf(h)).find((x) => x.name === 'quote');
    for (const p of ['model', 'prompt', 'image', 'resolution', 'size', 'duration', 'aspect', 'audio', 'provider', 'exclude']) {
      assert.ok(p in quote.inputSchema.properties, p);
    }
    assert.ok(quote.inputSchema.required.includes('model'));
    assert.equal(quote.inputSchema.properties.duration.type, 'number');
    assert.equal(quote.inputSchema.properties.audio.type, 'boolean');
    assert.equal(quote.inputSchema.properties.exclude.type, 'array');
    for (const bad of ['yes', 'maxCost', 'max_cost', 'allowOverLimit', 'dryRun']) {
      assert.ok(!(bad in quote.inputSchema.properties), `quote has no ${bad}`);
    }
  });

  test('wait_job bounds its timeout to 1-120 seconds', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    const wait = (await toolsOf(h)).find((x) => x.name === 'wait_job');
    const p = wait.inputSchema.properties.timeoutSeconds;
    assert.equal(p.minimum, 1);
    assert.equal(p.maximum, 120);
    assert.ok(wait.inputSchema.required.includes('job'));
  });

  test('no tool takes an API key, token or secret', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    for (const tool of await toolsOf(h)) {
      for (const name of propertyNames(tool.inputSchema)) {
        assert.doesNotMatch(name, /key|token|secret|password|credential|authorization/i, `${tool.name}.${name}`);
      }
    }
  });
});

describe('unknown arguments are rejected', () => {
  const rejected = (reply) => {
    if (reply.error) { assert.equal(reply.error.code, -32602); return; }
    assert.equal(reply.result.isError, true, JSON.stringify(reply.result));
    assert.equal(reply.result.structuredContent.error.code, 'usage');
  };

  for (const name of TOOL_NAMES) {
    test(`${name}`, async (t) => {
      const h = await startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
      await h.useLegacy();
      const base = { models: {}, providers: {}, quote: { model: 'seedance-2.0-mini' }, run: { quoteId: 'q' },
        job_status: { job: 'kie:task_kie_001' }, wait_job: { job: 'kie:task_kie_001' }, spend: {} }[name];
      rejected(await h.callRaw(name, { ...base, apiKey: 'sk-should-not-be-accepted' }));
      assert.equal(h.submits(), 0);
    });
  }

  test('a flag that only exists on the CLI (yes) is not accepted by run', async (t) => {
    const h = await startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: {} }) });
    await h.useLegacy();
    rejected(await h.callRaw('run', { quoteId: 'q', yes: true }));
    rejected(await h.callRaw('run', { quoteId: 'q', maxCost: 100 }));
    assert.equal(h.submits(), 0);
  });

  test('a missing required argument is rejected', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    rejected(await h.callRaw('quote', {}));
    rejected(await h.callRaw('run', {}));
    rejected(await h.callRaw('job_status', {}));
  });

  test('an argument of the wrong type is rejected', async (t) => {
    const h = await startMcp(t);
    await h.useLegacy();
    rejected(await h.callRaw('quote', { model: 'seedance-2.0-mini', duration: 'five' }));
    rejected(await h.callRaw('quote', { model: 'seedance-2.0-mini', exclude: 'kie' }));
  });
});

describe('quote', () => {
  test('returns the CLI quote plus a quoteId and an expiry, with a text copy, and makes no network call without keys', async (t) => {
    const h = await startMcp(t, { dataDir: DEFAULT_DATA_DIR });
    await h.useLegacy();
    const r = await h.call('quote', MINI);
    assert.notEqual(r.isError, true, JSON.stringify(r));
    const sc = r.structuredContent;
    assert.equal(typeof sc.quoteId, 'string');
    assert.ok(sc.quoteId.length >= 8);
    assert.equal(typeof sc.expiresAt, 'string');
    assert.ok(Date.parse(sc.expiresAt) > h.e.clock.ms, 'expires in the future');
    assert.ok(Date.parse(sc.expiresAt) - h.e.clock.ms <= 10 * 60_000 + 1000, 'within ten minutes');

    const cli = await h.e.run(quoteArgs('seedance-2.0-mini', '--prompt', MINI.prompt, '--res', '480p', '--duration', '5'));
    assert.equal(cli.code, 0, cli.stderr);
    const { quoteId, expiresAt, ...rest } = sc;
    assert.deepEqual(rest, cli.json, 'same JSON as `quote --json`');

    assert.equal(r.content[0].type, 'text');
    assert.deepEqual(parsedText(r), sc, 'the text copy holds the same JSON');
    assert.equal(h.e.calls.length, 0, 'no keys, so nothing was requested');
  });

  test('two quotes get different ids', async (t) => {
    const h = await startMcp(t, { dataDir: DEFAULT_DATA_DIR });
    await h.useLegacy();
    const a = await h.quote(MINI);
    const b = await h.quote(MINI);
    assert.notEqual(a.quoteId, b.quoteId);
  });

  test('every parameter reaches the CLI (a 4k request on real data matches the CLI)', async (t) => {
    const h = await startMcp(t, { dataDir: DEFAULT_DATA_DIR });
    h.useModern();
    const r = await h.call('quote', { model: 'seedance-2.0', prompt: 'x', resolution: '4k', duration: 4, aspect: '9:16', audio: false, exclude: ['fal'] });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    const cli = await h.e.run(quoteArgs('seedance-2.0', '--prompt', 'x', '--res', '4k', '--duration', '4', '--aspect', '9:16', '--no-audio', '--exclude', 'fal'));
    const { quoteId, expiresAt, ...rest } = r.structuredContent;
    assert.deepEqual(rest, cli.json);
    assert.notEqual(r.structuredContent.chosen, 'fal', 'an excluded provider is listed but never chosen');
  });

  test('a CLI error comes back as isError with the CLI error code', async (t) => {
    const h = await startMcp(t, { dataDir: DEFAULT_DATA_DIR });
    await h.useLegacy();
    const r = await h.call('quote', { model: 'no-such-model' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'usage');
    assert.match(r.structuredContent.error.message, /no-such-model/);
    assert.equal(parsedText(r).error.code, 'usage', 'the text copy has the error too');
    assert.equal(r.structuredContent.quoteId, undefined);
  });

  test('an unsupported resolution is a usage error too', async (t) => {
    const h = await startMcp(t, { dataDir: DEFAULT_DATA_DIR });
    await h.useLegacy();
    const r = await h.call('quote', { model: 'seedance-2.0-mini', resolution: '4k' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'usage');
  });

  test('a stateless client gets the same result with the modern envelope', async (t) => {
    const h = await startMcp(t, { dataDir: DEFAULT_DATA_DIR });
    h.useModern();
    const r = await h.call('quote', MINI);
    assert.equal(r.resultType, 'complete');
    assert.equal(typeof r.structuredContent.quoteId, 'string');
  });
});

describe('read-only tools match the CLI', () => {
  const setup = (t, extra = {}) => startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating'] } }), ...extra });

  test('models, with and without a search', async (t) => {
    const h = await setup(t, { dataDir: DEFAULT_DATA_DIR });
    await h.useLegacy();
    const all = await h.call('models', {});
    assert.notEqual(all.isError, true);
    assert.deepEqual(all.structuredContent, (await h.e.run(['models', '--json'])).json);
    const some = await h.call('models', { search: 'seedream' });
    assert.deepEqual(some.structuredContent, (await h.e.run(['models', '--search', 'seedream', '--json'])).json);
    assert.ok(some.structuredContent.models.length < all.structuredContent.models.length);
    assert.deepEqual(parsedText(all), all.structuredContent);
  });

  test('providers', async (t) => {
    const h = await setup(t);
    await h.useLegacy();
    const r = await h.call('providers', {});
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.deepEqual(r.structuredContent, (await h.e.run(['providers', '--json'])).json);
  });

  test('spend, with and without since', async (t) => {
    const h = await setup(t);
    await h.useLegacy();
    assert.equal((await h.e.run(runArgs('seedance-2.0-mini', '--res', '480p'))).code, 0);
    const r = await h.call('spend', {});
    assert.deepEqual(r.structuredContent, (await h.e.run(['spend', '--json'])).json);
    assert.equal(r.structuredContent.jobs.length, 1);
    const none = await h.call('spend', { since: '2030-01-01' });
    assert.deepEqual(none.structuredContent, (await h.e.run(['spend', '--since', '2030-01-01', '--json'])).json);
    assert.equal(none.structuredContent.jobs.length, 0);
  });

  test('spend with a bad date is a usage error', async (t) => {
    const h = await setup(t);
    await h.useLegacy();
    const r = await h.call('spend', { since: 'last tuesday-ish' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'usage');
  });

  test('job_status', async (t) => {
    const h = await setup(t);
    await h.useLegacy();
    const r = await h.call('job_status', { job: 'kie:task_kie_001' });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.deepEqual(r.structuredContent, (await h.e.run(['status', 'kie:task_kie_001', '--json'])).json);
    assert.equal(r.structuredContent.state, 'running');
  });

  test('job_status for a malformed job id is a usage error', async (t) => {
    const h = await setup(t);
    await h.useLegacy();
    const r = await h.call('job_status', { job: 'no-colon-here' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'usage');
  });

  test('job_status for a provider without a key is an error naming it', async (t) => {
    const h = await setup(t);
    await h.useLegacy();
    const r = await h.call('job_status', { job: 'replicate:rep_pred_001' });
    assert.equal(r.isError, true);
    assert.equal(typeof r.structuredContent.error.code, 'string');
    assert.equal(h.e.calls.filter((c) => /replicate/.test(c.url)).length, 0);
  });
});

describe('wait_job', () => {
  test('a job still running when the timeout passes comes back as state running, not an error', async (t) => {
    const h = await startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating'] } }) });
    await h.useLegacy();
    const r = await h.call('wait_job', { job: 'kie:task_kie_001', timeoutSeconds: 1 });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(r.structuredContent.state, 'running');
    assert.equal(r.structuredContent.job, 'kie:task_kie_001');
    assert.equal(parsedText(r).state, 'running');
  });

  test('a finished job returns its result and saves files under <cwd>/cheapgen-out', async (t) => {
    const h = await startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating', 'success'] } }) });
    await h.useLegacy();
    const r = await h.call('wait_job', { job: 'kie:task_kie_001' });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.equal(r.structuredContent.state, 'succeeded');
    assert.ok(r.structuredContent.files.length > 0, 'a file path is returned');
    for (const f of r.structuredContent.files) {
      assert.ok(fs.existsSync(f), f);
      assert.ok(path.resolve(f).startsWith(path.join(h.e.cwd, 'cheapgen-out')), `${f} is in the download folder`);
    }
    assert.ok(r.structuredContent.outputs.length > 0, 'result URLs are returned too');
  });

  test('a job that failed is reported as an error with the CLI code', async (t) => {
    const h = await startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['fail'] } }) });
    await h.useLegacy();
    const r = await h.call('wait_job', { job: 'kie:task_kie_001', timeoutSeconds: 5 });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'job_failed');
  });

  for (const bad of [0, 121, 100000, -5, 1.5e9]) {
    test(`timeoutSeconds ${bad} is rejected before any request`, async (t) => {
      const h = await startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating'] } }) });
      await h.useLegacy();
      const reply = await h.callRaw('wait_job', { job: 'kie:task_kie_001', timeoutSeconds: bad });
      if (reply.error) assert.equal(reply.error.code, -32602);
      else {
        assert.equal(reply.result.isError, true);
        assert.equal(reply.result.structuredContent.error.code, 'usage');
      }
      assert.equal(h.e.calls.length, 0);
    });
  }

  test('120 seconds is the largest accepted timeout', async (t) => {
    const h = await startMcp(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating'] } }) });
    await h.useLegacy();
    const before = h.e.clock.ms;
    const r = await h.call('wait_job', { job: 'kie:task_kie_001', timeoutSeconds: 120 });
    assert.equal(r.structuredContent.state, 'running');
    const waited = h.e.clock.ms - before;
    assert.ok(waited >= 120_000 && waited < 180_000, `waited ${waited} ms on the fake clock`);
  });
});
