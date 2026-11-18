// Keys never appear in output, logs, the spend log, the cache or error messages,
// driven through success and every error path. Provider error responses deliberately ECHO
// the Authorization header back, the way misbehaving APIs sometimes do, and fetch errors
// carry the key in their message, so redaction is genuinely exercised.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEnvironment, runArgs, walkFiles } from './helpers/harness.js';
import { routesFor, fixture } from './helpers/providers.js';

const SECRETS = {
  KIE_API_KEY: 'KIE-SECRET-k1e9Zq7x',
  REPLICATE_API_TOKEN: 'r8_SECRETrep1icateT0kenQ9',
  WAVESPEED_API_KEY: 'WS-SECRET-w4v3sp33d77',
  FAL_KEY: 'fal-secret-id-1234:fal-secret-value-98765',
};
const ALL = Object.values(SECRETS);
const MINI = ['seedance-2.0-mini', '--res', '480p'];
const V20 = ['seedance-2.0', '--res', '480p'];

const echoAuth = (status, shape) => (req) => ({ status, json: shape(`Invalid credentials ${req.headers.authorization ?? ''}`) });

function assertNoKeys(e, label, extraFiles = []) {
  const haystacks = { output: e.allOutput(), spendLog: e.spendText() };
  for (const dir of [e.home, e.cwd]) {
    for (const f of walkFiles(dir)) {
      if (extraFiles.includes(f)) continue;
      if (f.endsWith('.mp4')) continue; // downloaded media is fake bytes
      haystacks[f] = fs.readFileSync(f, 'utf8');
    }
  }
  for (const [where, text] of Object.entries(haystacks)) {
    for (const key of ALL) {
      assert.ok(!text.includes(key), `${label}: key ${key.slice(0, 8)}... leaked into ${where}`);
      for (const part of key.split(/[:\-_]/).filter((p) => p.length >= 8)) {
        assert.ok(!text.includes(part), `${label}: part of a key (${part}) leaked into ${where}`);
      }
    }
  }
}

/** The key must really be sent to the provider, otherwise "no leak" would be trivially true. */
function assertKeyWasUsed(e, secret) {
  assert.ok(e.calls.some((c) => JSON.stringify(c.headers).includes(secret)), 'adapter should authenticate with the key');
}

const scenarios = [
  {
    name: 'success with --wait',
    argv: [...MINI, '--wait'], providers: ['kie'], routes: () => routesFor({ kie: {} }), code: 0, used: 'KIE_API_KEY',
  },
  {
    name: 'rejection whose message echoes the key, then fallback',
    argv: [...MINI], providers: ['kie', 'replicate'], code: 0, used: 'KIE_API_KEY',
    routes: () => routesFor({ kie: { submit: echoAuth(401, (m) => ({ code: 401, msg: m, data: null })) }, replicate: {} }),
  },
  {
    name: 'every provider rejects with an echoing message',
    argv: [...MINI], providers: ['kie', 'replicate'], code: 3, used: 'REPLICATE_API_TOKEN',
    routes: () => routesFor({
      kie: { submit: echoAuth(401, (m) => ({ code: 401, msg: m })) },
      replicate: { submit: echoAuth(401, (m) => ({ title: 'Unauthenticated', detail: m, status: 401 })) },
    }),
  },
  {
    name: 'WaveSpeed rejection echoing the key',
    argv: [...MINI], providers: ['wavespeed'], code: 3, used: 'WAVESPEED_API_KEY',
    routes: () => routesFor({ wavespeed: { submit: echoAuth(401, (m) => ({ code: 401, message: m })) } }),
  },
  {
    name: 'fal rejection echoing the Key header',
    argv: [...MINI], providers: ['fal'], code: 3, used: 'FAL_KEY',
    routes: () => routesFor({ fal: { submit: echoAuth(401, (m) => ({ detail: m })) } }),
  },
  {
    name: 'unknown outcome: network error whose message contains the key',
    argv: [...MINI], providers: ['kie'], code: 5, used: 'KIE_API_KEY',
    routes: () => routesFor({ kie: { submit: { error: new TypeError(`fetch failed: Bearer ${SECRETS.KIE_API_KEY}`) } } }),
  },
  {
    name: 'unknown outcome: 500 whose body echoes the key',
    argv: [...MINI], providers: ['wavespeed'], code: 5, used: 'WAVESPEED_API_KEY',
    routes: () => routesFor({ wavespeed: { submit: echoAuth(500, (m) => ({ code: 500, message: m })) } }),
  },
  {
    name: 'job failed after acceptance, failure message contains the key',
    argv: [...MINI, '--wait'], providers: ['kie'], code: 6, used: 'KIE_API_KEY',
    routes: () => {
      const failing = fixture('kie', 'status-fail');
      failing.data.failMsg = `upstream rejected Bearer ${SECRETS.KIE_API_KEY} (${SECRETS.KIE_API_KEY})`;
      const routes = routesFor({ kie: {} });
      routes.find((r) => String(r.url).includes('recordInfo')).responses = [{ status: 200, json: failing }];
      return routes;
    },
  },
  {
    name: 'replicate job failure with the token in the error text',
    argv: [...V20, '--wait'], providers: ['replicate'], code: 6, used: 'REPLICATE_API_TOKEN',
    routes: () => {
      const routes = routesFor({ replicate: {} });
      routes.find((r) => r.method === 'GET' && r.url instanceof RegExp && r.url.test('https://api.replicate.com/v1/predictions/x')).responses = [
        { status: 200, json: { id: 'rep_pred_001', status: 'failed', error: `auth ${SECRETS.REPLICATE_API_TOKEN} rejected` } }];
      return routes;
    },
  },
];

describe('keys never leak', () => {
  for (const s of scenarios) {
    for (const json of [false, true]) {
      test(`${s.name}${json ? ' (--json)' : ''}`, async (t) => {
        const env = Object.fromEntries(s.providers.map((p) => {
          const v = { kie: 'KIE_API_KEY', replicate: 'REPLICATE_API_TOKEN', wavespeed: 'WAVESPEED_API_KEY', fal: 'FAL_KEY' }[p];
          return [v, SECRETS[v]];
        }));
        const e = createEnvironment(t, { env, routes: s.routes() });
        const argv = ['run', s.argv[0], '--prompt', 'a calm lake', ...s.argv.slice(1)];
        if (json) argv.push('--json');
        const r = await e.run(argv);
        assert.equal(r.code, s.code, `${r.stdout}\n${r.stderr}`);
        assertKeyWasUsed(e, SECRETS[s.used]);
        assertNoKeys(e, s.name);
      });
    }
  }

  test('usage errors and a missing-key error do not leak either', async (t) => {
    const e = createEnvironment(t, { env: { KIE_API_KEY: SECRETS.KIE_API_KEY }, routes: [] });
    await e.run(runArgs(...MINI, '--duration', 'auto'));
    await e.run(['status', 'bogus:abc']);
    await e.run(['status', 'replicate:abc']);
    assertNoKeys(e, 'usage errors');
  });

  test('`providers`, `config show` and `spend` never print keys', async (t) => {
    const e = createEnvironment(t, { env: SECRETS, routes: routesFor({ kie: {}, wavespeed: {}, fal: {} }) });
    await e.run(['providers', '--json']);
    await e.run(['providers']);
    const shown = await e.run(['config', 'show']);
    assert.equal(shown.code, 0, shown.stderr);
    await e.run(['spend']);
    assertNoKeys(e, 'inspection commands');
  });

  test('a key stored by `config set-key` is never echoed, logged or cached', async (t) => {
    const stored = 'STORED-IN-FILE-key-7788abcd';
    const e = createEnvironment(t, { routes: routesFor({ kie: { submit: echoAuth(401, (m) => ({ code: 401, msg: m })) } }) });
    const set = await e.run(['config', 'set-key', 'kie'], { stdin: `${stored}\n` });
    assert.equal(set.code, 0, set.stderr);
    const run = await e.run(runArgs(...MINI));
    assert.notEqual(run.code, 0);
    assert.ok(e.calls.some((c) => JSON.stringify(c.headers).includes(stored)), 'the stored key was used');
    await e.run(['config', 'show']);
    const text = [e.allOutput(), e.spendText(), ...walkFiles(e.home).filter((f) => f !== e.userConfigPath && f !== e.spendPath)
      .map((f) => fs.readFileSync(f, 'utf8'))].join('\n');
    assert.ok(!text.includes(stored));
  });

  test('keys are not passed on the command line: the CLI refuses them as arguments (see access tests)', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'set-key', 'kie', SECRETS.KIE_API_KEY]);
    assert.equal(r.code, 2);
    assert.ok(!r.stdout.includes(SECRETS.KIE_API_KEY) && !r.stderr.includes(SECRETS.KIE_API_KEY),
      'even the rejection message must not echo the key');
  });
});
