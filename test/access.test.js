// No keys set, and where keys come from (a provider is connected when its key is in the
// environment or the config file; the environment wins).
// Exit code 3 = no usable provider.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, KEYS, keysFor, runArgs } from './helpers/harness.js';
import { routesFor, submitCalls } from './helpers/providers.js';

const ENV_VARS = ['KIE_API_KEY', 'REPLICATE_API_TOKEN', 'WAVESPEED_API_KEY', 'FAL_KEY'];
const allText = (r) => `${r.stdout}\n${r.stderr}`;

describe('no keys set', () => {
  const commands = [
    runArgs('seedance-2.0-mini', '--res', '480p'),
    ['providers'],
    ['status', 'kie:task_1'],
    ['wait', 'kie:task_1'],
  ];
  for (const argv of commands) {
    test(`'${argv[0]}' exits non-zero and names every environment variable`, async (t) => {
      const e = createEnvironment(t, { routes: [] }); // any request would fail the test
      const r = await e.run(argv);
      assert.notEqual(r.code, 0);
      for (const v of ENV_VARS) assert.ok(allText(r).includes(v), `output should mention ${v}`);
      assert.equal(r.calls.length, 0, 'no request without a key');
    });
  }

  test('run with no keys exits with code 3 (no usable provider)', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(runArgs('seedance-2.0-mini', '--res', '480p'));
    assert.equal(r.code, 3);
    assert.equal(e.spendLines().length, 0);
  });

  test('models, quote and prices still work without any key', async (t) => {
    const e = createEnvironment(t);
    const models = await e.run(['models']);
    assert.equal(models.code, 0);
    const quote = await e.run(['quote', 'seedance-2.0-mini', '--res', '480p', '--json']);
    assert.equal(quote.code, 0);
    assert.equal(quote.calls.length, 0, 'quote prices unconnected providers from bundled data only');
  });

  test('prices --check does not demand a key', async (t) => {
    // Everything answers 503 so the check cannot find live prices; it must still not ask for keys.
    const e = createEnvironment(t, { routes: [{ method: '*', url: /.*/, status: 503, json: {} }] });
    const r = await e.run(['prices', '--check']);
    assert.notEqual(r.code, 3);
    for (const v of ENV_VARS) assert.ok(!allText(r).includes(v), `should not mention ${v}`);
  });
});

describe('where keys come from', () => {
  const args = runArgs('seedance-2.0-mini', '--res', '480p');

  test('a key stored with `config set-key` (stdin) connects the provider', async (t) => {
    const e = createEnvironment(t, { routes: routesFor('kie') });
    const set = await e.run(['config', 'set-key', 'kie'], { stdin: 'file-stored-kie-key\n' });
    assert.equal(set.code, 0);
    assert.ok(!allText(set).includes('file-stored-kie-key'), 'set-key must not echo the key');
    const r = await e.run(args);
    assert.equal(r.code, 0);
    assert.equal(r.json.provider, 'kie');
    assert.ok(JSON.stringify(submitCalls(e.calls, 'kie')[0].headers).includes('file-stored-kie-key'));
  });

  test('an environment key overrides the key in the config file', async (t) => {
    const e = createEnvironment(t, { routes: routesFor('kie'), env: keysFor('kie') });
    await e.run(['config', 'set-key', 'kie'], { stdin: 'file-stored-kie-key\n' });
    const r = await e.run(args);
    assert.equal(r.code, 0);
    const headers = JSON.stringify(submitCalls(e.calls, 'kie')[0].headers);
    assert.ok(headers.includes(KEYS.KIE_API_KEY));
    assert.ok(!headers.includes('file-stored-kie-key'));
  });

  test('set-key refuses a key passed as a command-line argument and stores nothing', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'set-key', 'kie', 'key-on-the-command-line']);
    assert.equal(r.code, 2);
    const fs = await import('node:fs');
    assert.ok(!fs.existsSync(e.userConfigPath) || !fs.readFileSync(e.userConfigPath, 'utf8').includes('key-on-the-command-line'));
  });

  test('set-key rejects an unknown provider and an empty key', async (t) => {
    const e = createEnvironment(t);
    assert.equal((await e.run(['config', 'set-key', 'nope'], { stdin: 'k\n' })).code, 2);
    assert.equal((await e.run(['config', 'set-key', 'kie'], { stdin: '\n' })).code, 2);
  });
});
