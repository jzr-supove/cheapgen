// Config layering and precedence.
// Layers, lowest to highest: built-in defaults, user file, project file (./.cheapgen.json),
// environment keys, command-line flags. Merging is per key; providers.<id> and models.<id> merge
// field by field; arrays (prefer) replace; unknown keys warn instead of failing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createEnvironment, keysFor, runArgs } from './helpers/harness.js';
import { routesFor, submitCalls } from './helpers/providers.js';

const MINI = ['seedance-2.0-mini', '--res', '480p'];
const BOTH = () => ({ env: keysFor('kie', 'replicate'), routes: routesFor({ kie: {}, replicate: {} }) });
const chosen = async (e, ...extra) => (await e.run(runArgs(...MINI, ...extra))).json?.provider;

describe('built-in defaults', () => {
  test('with no config files: strategy cheapest, limit $1.00, showUnconnected true', async (t) => {
    const e = createEnvironment(t, BOTH());
    assert.equal(await chosen(e), 'kie');
    assert.equal((await e.run(runArgs('seedance-2.0', '--res', '720p', '--duration', '15'))).code, 4, '3.075 > 1.00');
    const q = await e.run(['quote', ...MINI, '--json']);
    assert.equal(q.json.quotes.length, 4, 'unconnected providers shown by default');
  });
});

describe('user file vs project file', () => {
  test('the project file overrides the user file key by key', async (t) => {
    const e = createEnvironment(t, {
      ...BOTH(),
      userConfig: { providers: { kie: { enabled: false } } },
      projectConfig: { providers: { kie: { enabled: true } } },
    });
    assert.equal(await chosen(e), 'kie');
  });

  test('keys the project file does not set still come from the user file', async (t) => {
    const e = createEnvironment(t, {
      ...BOTH(),
      userConfig: { maxCostPerRun: 0.10 },
      projectConfig: { strategy: 'cheapest' },
    });
    const r = await e.run(runArgs('seedance-2.0-mini', '--res', '720p')); // 0.205
    assert.equal(r.code, 4, 'the user-level limit must survive a project file that does not mention it');
  });

  test('providers.<id> merges field by field across files', async (t) => {
    const e = createEnvironment(t, {
      ...BOTH(),
      userConfig: { providers: { kie: { enabled: false } } },
      projectConfig: { providers: { replicate: { enabled: false } } },
    });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 3, 'both providers are disabled, one in each file');
    assert.equal(e.calls.length, 0);
  });

  test('models.<id> pins merge and the project pin wins on conflict', async (t) => {
    const e = createEnvironment(t, {
      ...BOTH(),
      userConfig: { models: { 'seedance-2.0-mini': { provider: 'kie' }, 'seedance-2.0': { provider: 'kie' } } },
      projectConfig: { models: { 'seedance-2.0-mini': { provider: 'replicate' } } },
    });
    assert.equal(await chosen(e), 'replicate');
    assert.equal((await e.run(runArgs('seedance-2.0', '--res', '480p'))).json.provider, 'kie', 'user pin for another model survives');
  });

  test('the prefer array in the project file replaces the user array, it does not concatenate', async (t) => {
    const e = createEnvironment(t, {
      ...BOTH(),
      userConfig: { strategy: 'preferred', prefer: ['kie'] },
      projectConfig: { prefer: ['replicate'] },
    });
    assert.equal(await chosen(e), 'replicate');
  });

  test('CHEAPGEN_CONFIG replaces the default user file location', async (t) => {
    const e = createEnvironment(t, BOTH());
    const custom = path.join(e.cwd, 'elsewhere', 'my-config.json');
    e.writeUserConfig({ providers: { kie: { enabled: true } } });                      // default location, ignored
    e.writeUserConfig({ providers: { kie: { enabled: false } } }, custom);
    const r = await e.run(runArgs(...MINI), { env: { CHEAPGEN_CONFIG: custom } });
    assert.equal(r.json.provider, 'replicate');

    // and the other way round: the default file is not read when CHEAPGEN_CONFIG is set
    e.writeUserConfig({ providers: { kie: { enabled: false } } });
    e.writeUserConfig({}, custom);
    assert.equal((await e.run(runArgs(...MINI), { env: { CHEAPGEN_CONFIG: custom } })).json.provider, 'kie');
  });
});

describe('command-line flags are the highest layer', () => {
  test('--max-cost and --provider beat the config file for one run only', async (t) => {
    const e = createEnvironment(t, {
      ...BOTH(),
      userConfig: { maxCostPerRun: 0.05, models: { 'seedance-2.0-mini': { provider: 'kie' } } },
    });
    const first = await e.run(runArgs(...MINI, '--max-cost', '1', '--provider', 'replicate'));
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.provider, 'replicate');
    const next = await e.run(runArgs(...MINI));
    assert.equal(next.code, 4, 'config limit of $0.05 applies again');
  });
});

describe('unknown keys', () => {
  test('an unknown config key produces a warning, not an error', async (t) => {
    const e = createEnvironment(t, { ...BOTH(), userConfig: { futureSetting: 1, strategy: 'cheapest' } });
    const r = await e.run(runArgs(...MINI));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /futureSetting/);
    assert.equal(submitCalls(e.calls, 'kie').length, 1);
  });
});

describe('config command', () => {
  test('`config show` works and prints effective settings (not keys)', async (t) => {
    const e = createEnvironment(t, { ...BOTH(), userConfig: { maxCostPerRun: 0.42 } });
    const r = await e.run(['config', 'show']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /0\.42/);
  });
});
