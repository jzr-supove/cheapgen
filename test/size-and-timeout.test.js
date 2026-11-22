// --size (image models only, default 1K) and --timeout (how long `run --wait` and `wait` poll).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DATA_DIR } from '../src/catalog.js';
import { createEnvironment, keysFor, runArgs, quoteArgs } from './helpers/harness.js';
import { routesFor, submitCalls } from './helpers/providers.js';

const JOB = 'kie:task_kie_001';
const VIDEO = ['seedance-2.0-mini', '--res', '480p'];
const IMAGE = 'flux-2-pro';

describe('--size', () => {
  const imageEnv = (t) => createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('replicate'),
    routes: [{ method: 'POST', url: 'https://api.kie.ai/client/v1/model-pricing/page', status: 503, json: {} },
      ...routesFor('replicate')] });

  test('an image is 1K unless --size says otherwise', async (t) => {
    const e = imageEnv(t);
    assert.equal((await e.run(quoteArgs(IMAGE))).json.params.size, '1K');
    assert.equal((await e.run(quoteArgs(IMAGE, '--size', '2K'))).json.params.size, '2K');
  });

  test('a bigger size is priced and sent as that size', async (t) => {
    const e = imageEnv(t);
    const price = async (size) =>
      (await e.run(quoteArgs(IMAGE, '--aspect', '1:1', '--size', size))).json.quotes.find((q) => q.provider === 'replicate').usd;
    assert.ok(await price('2K') > await price('1K'));
    const body = async (size) => {
      const r = await e.run(runArgs(IMAGE, '--aspect', '1:1', '--size', size, '--dry-run'));
      assert.equal(r.code, 0, r.stderr);
      return JSON.stringify(r.json);
    };
    assert.notEqual(await body('1K'), await body('2K'));
    assert.equal(submitCalls(e.calls, 'replicate').length, 0);
  });

  for (const [label, args, message] of [
    ['a size the model lacks', [IMAGE, '--size', '9K'], /9K.*1K/],
    ['--size on a video model', ['seedance-2.0-mini', '--size', '1K'], /--size/],
    ['--res on an image model', [IMAGE, '--res', '480p'], /--res/],
  ]) {
    test(`${label} is a usage error (exit 2)`, async (t) => {
      const r = await imageEnv(t).run(quoteArgs(...args));
      assert.equal(r.code, 2);
      assert.match(r.stderr + r.stdout, message);
    });
  }
});

describe('--timeout', () => {
  const pending = (t) => createEnvironment(t, { env: keysFor('kie'), routes: routesFor({ kie: { states: ['generating'] } }) });
  const waited = async (e, args) => {
    const from = e.clock.ms;
    const r = await e.run(args);
    assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`);
    return { r, seconds: Math.round((e.clock.ms - from) / 1000) };
  };

  test('run --wait gives up after that many seconds, with exit 7 and the job id', async (t) => {
    const { r, seconds } = await waited(pending(t), runArgs(...VIDEO, '--wait', '--timeout', '90'));
    assert.equal(seconds, 90);
    assert.match(r.stdout + r.stderr, new RegExp(JOB));
  });

  test('wait does too', async (t) => {
    const e = pending(t);
    await e.run(runArgs(...VIDEO));
    assert.equal((await waited(e, ['wait', JOB, '--timeout', '40', '--json'])).seconds, 40);
  });

  test('without it, a video waits 15 minutes', async (t) => {
    assert.equal((await waited(pending(t), runArgs(...VIDEO, '--wait'))).seconds, 15 * 60);
  });

  test('without it, an image waits 5 minutes', async (t) => {
    const e = createEnvironment(t, { dataDir: DEFAULT_DATA_DIR, env: keysFor('replicate'),
      routes: [{ method: 'POST', url: 'https://api.kie.ai/client/v1/model-pricing/page', status: 503, json: {} },
        ...routesFor({ replicate: { states: ['processing'] } })] });
    assert.equal((await waited(e, runArgs(IMAGE, '--wait'))).seconds, 5 * 60);
  });

  for (const [seconds, text] of [['1', '1 second'], ['20', '20 seconds'], ['60', '1 minute'], ['90', '90 seconds'], ['120', '2 minutes']]) {
    test(`the message for ${seconds} says it waited ${text}`, async (t) => {
      const { r } = await waited(pending(t), runArgs(...VIDEO, '--wait', '--timeout', seconds));
      assert.match(r.stdout + r.stderr, new RegExp(`after ${text}\\.`));
    });
  }

  for (const bad of ['0', '-5', 'soon', 'Infinity']) {
    test(`--timeout=${bad} is a usage error (exit 2) and nothing is submitted`, async (t) => {
      const e = pending(t);
      const r = await e.run(runArgs(...VIDEO, '--wait', `--timeout=${bad}`));
      assert.equal(r.code, 2);
      assert.match(r.stderr + r.stdout, /--timeout/);
      assert.equal(submitCalls(e.calls, 'kie').length, 0);
    });
  }
});
