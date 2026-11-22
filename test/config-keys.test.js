// `config set-key` with a hidden prompt, `config list`, `config get-key`, and the
// no-echo line reader behind the prompt.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { createEnvironment, KEYS, keysFor } from './helpers/harness.js';

const ORDER = ['kie', 'replicate', 'wavespeed', 'fal'];
const ENV_NAME = { kie: 'KIE_API_KEY', replicate: 'REPLICATE_API_TOKEN', wavespeed: 'WAVESPEED_API_KEY', fal: 'FAL_KEY' };
const allText = (r) => r.stdout + r.stderr;
const mask = (key) => (key.length < 12 ? '****' : `****${key.slice(-4)}`);
const prompter = (answer) => {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return typeof answer === 'function' ? answer() : answer; };
  fn.calls = calls;
  return fn;
};
const storedFileText = (e) => (fs.existsSync(e.userConfigPath) ? fs.readFileSync(e.userConfigPath, 'utf8') : '');

describe('config set-key with a hidden prompt', () => {
  test('asks once, naming the provider, and stores the trimmed answer', async (t) => {
    const e = createEnvironment(t);
    const p = prompter('  typed-kie-secret-9876 \n');
    const r = await e.run(['config', 'set-key', 'kie'], { promptSecret: p });
    assert.equal(r.code, 0, allText(r));
    assert.equal(p.calls.length, 1);
    assert.equal(typeof p.calls[0][0], 'string');
    assert.match(p.calls[0][0], /Kie/);
    const stored = storedFileText(e);
    assert.ok(stored.includes('"typed-kie-secret-9876"'), 'trimmed key should be stored exactly');
    const got = await e.run(['config', 'get-key', 'kie', '--json']);
    assert.equal(got.json.masked, '****9876');
    assert.equal(got.json.source, 'file');
  });

  test('never echoes the key, and --json keeps stdout to one document', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'set-key', 'replicate', '--json'], { promptSecret: prompter('r8_promptedSECRETtoken77') });
    assert.equal(r.code, 0, allText(r));
    assert.ok(!allText(r).includes('r8_promptedSECRETtoken77'));
    assert.ok(!allText(r).includes('promptedSECRET'));
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout must be a single JSON document');
    assert.equal(JSON.parse(r.stdout).provider, 'replicate');
  });

  test('Ctrl+C (null) cancels with exit 2 and leaves an earlier key unchanged', async (t) => {
    const e = createEnvironment(t);
    await e.run(['config', 'set-key', 'kie'], { stdin: 'original-kie-key-1111\n' });
    const before = storedFileText(e);
    const r = await e.run(['config', 'set-key', 'kie'], { promptSecret: prompter(null) });
    assert.equal(r.code, 2);
    assert.match(allText(r), /cancel/i);
    assert.equal(storedFileText(e), before);
  });

  test('Ctrl+C with no earlier key stores nothing', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'set-key', 'fal'], { promptSecret: prompter(null) });
    assert.equal(r.code, 2);
    assert.ok(!storedFileText(e).includes('"key"'));
  });

  for (const [label, answer] of [['empty', ''], ['whitespace-only', '  \t \n']]) {
    test(`a ${label} answer is rejected with exit 2 and nothing stored`, async (t) => {
      const e = createEnvironment(t);
      const r = await e.run(['config', 'set-key', 'kie'], { promptSecret: prompter(answer) });
      assert.equal(r.code, 2);
      assert.ok(!storedFileText(e).includes('"key"'));
      const got = await e.run(['config', 'get-key', 'kie']);
      assert.equal(got.code, 3);
    });
  }

  for (const [label, argv] of [
    ['an unknown provider', ['config', 'set-key', 'nope']],
    ['a missing provider', ['config', 'set-key']],
    ['an extra argument', ['config', 'set-key', 'kie', 'extra-arg']],
  ]) {
    test(`${label} fails with exit 2 before prompting`, async (t) => {
      const e = createEnvironment(t);
      const p = prompter('should-not-be-asked-123');
      const r = await e.run(argv, { promptSecret: p });
      assert.equal(r.code, 2);
      assert.equal(p.calls.length, 0);
      assert.ok(!storedFileText(e).includes('should-not-be-asked-123'));
    });
  }

  test('piped stdin still works when no prompt function is supplied', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'set-key', 'wavespeed'], { stdin: '\n  piped-ws-key-5555  \n' });
    assert.equal(r.code, 0, allText(r));
    assert.ok(storedFileText(e).includes('"piped-ws-key-5555"'));
  });
});

describe('config list', () => {
  test('--json lists the four providers in order with source and masked key', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'fal') });
    await e.run(['config', 'set-key', 'replicate'], { stdin: 'short-key1\n' });
    const r = await e.run(['config', 'list', '--json']);
    assert.equal(r.code, 0, allText(r));
    assert.deepEqual(r.json.keys.map((k) => k.provider), ORDER);
    const by = Object.fromEntries(r.json.keys.map((k) => [k.provider, k]));
    assert.deepEqual(by.kie, { provider: 'kie', envVar: 'KIE_API_KEY', set: true, source: 'env', masked: mask(KEYS.KIE_API_KEY) });
    assert.deepEqual(by.fal, { provider: 'fal', envVar: 'FAL_KEY', set: true, source: 'env', masked: mask(KEYS.FAL_KEY) });
    assert.deepEqual(by.replicate, { provider: 'replicate', envVar: 'REPLICATE_API_TOKEN', set: true, source: 'file', masked: '****' });
    assert.deepEqual(by.wavespeed, { provider: 'wavespeed', envVar: 'WAVESPEED_API_KEY', set: false, source: null, masked: null });
  });

  test('--json settings equal the effective settings and files are reported', async (t) => {
    const e = createEnvironment(t, { userConfig: { maxCostPerRun: 0.37 } });
    const r = await e.run(['config', 'list', '--json']);
    assert.equal(r.code, 0, allText(r));
    assert.equal(r.json.settings.maxCostPerRun, 0.37);
    assert.equal(r.json.settings.strategy, 'cheapest');
    const shown = await e.run(['config', 'show', '--json']);
    assert.deepEqual(r.json.settings, shown.json.settings);
    assert.equal(r.json.files.user, e.userConfigPath);
    assert.equal(r.json.files.project, e.projectConfigPath);
  });

  test('works with no keys at all', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'list', '--json']);
    assert.equal(r.code, 0, allText(r));
    assert.equal(r.json.keys.length, 4);
    assert.ok(r.json.keys.every((k) => k.set === false && k.source === null && k.masked === null));
  });

  test('text output has a line per provider with its source and masked key, plus settings', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie'), userConfig: { maxCostPerRun: 0.5 } });
    await e.run(['config', 'set-key', 'fal'], { stdin: `${KEYS.FAL_KEY}\n` });
    const r = await e.run(['config', 'list']);
    assert.equal(r.code, 0, allText(r));
    assert.equal(r.json, null, 'text output must not be JSON');
    const lines = r.stdout.split('\n');
    const line = (re) => lines.find((l) => re.test(l)) ?? '';
    assert.match(line(/kie/i), /KIE_API_KEY/);
    assert.ok(line(/kie/i).includes(mask(KEYS.KIE_API_KEY)));
    assert.match(line(/replicate/i), /not set/);
    assert.match(line(/wavespeed/i), /not set/);
    assert.match(line(/fal/i), /config file/);
    assert.ok(line(/fal/i).includes(mask(KEYS.FAL_KEY)));
    assert.match(r.stdout, /maxCostPerRun/);
    assert.match(r.stdout, /0\.5/);
  });

  test('extra arguments are a usage error', async (t) => {
    const e = createEnvironment(t);
    assert.equal((await e.run(['config', 'list', 'kie'])).code, 2);
  });

  test('full keys never appear in text or json output', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie', 'replicate', 'wavespeed') });
    await e.run(['config', 'set-key', 'fal'], { stdin: `${KEYS.FAL_KEY}\n` });
    for (const argv of [['config', 'list'], ['config', 'list', '--json']]) {
      const r = await e.run(argv);
      for (const key of Object.values(KEYS)) assert.ok(!allText(r).includes(key), `${argv.join(' ')} leaked ${key.slice(0, 8)}`);
    }
  });
});

describe('config get-key', () => {
  test('--json reports provider, env var, source and masked key', async (t) => {
    const e = createEnvironment(t);
    await e.run(['config', 'set-key', 'wavespeed'], { stdin: `${KEYS.WAVESPEED_API_KEY}\n` });
    const r = await e.run(['config', 'get-key', 'wavespeed', '--json']);
    assert.equal(r.code, 0, allText(r));
    assert.deepEqual(r.json, { provider: 'wavespeed', envVar: 'WAVESPEED_API_KEY', set: true, source: 'file', masked: mask(KEYS.WAVESPEED_API_KEY) });
  });

  test('text output shows provider, masked key and source', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie') });
    const r = await e.run(['config', 'get-key', 'kie']);
    assert.equal(r.code, 0, allText(r));
    assert.match(r.stdout, /kie/i);
    assert.ok(r.stdout.includes(mask(KEYS.KIE_API_KEY)));
    assert.match(r.stdout, /KIE_API_KEY/);
  });

  test('the environment wins over the config file', async (t) => {
    const e = createEnvironment(t, { env: keysFor('kie') });
    await e.run(['config', 'set-key', 'kie'], { stdin: 'file-stored-kie-key-ZZZZ\n' });
    const r = await e.run(['config', 'get-key', 'kie', '--json']);
    assert.equal(r.json.source, 'env');
    assert.equal(r.json.masked, mask(KEYS.KIE_API_KEY));
  });

  test('a provider with no key exits 3 with not_connected and says how to add one', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'get-key', 'replicate', '--json']);
    assert.equal(r.code, 3);
    assert.equal(r.error.code, 'not_connected');
    assert.match(r.error.message, /config set-key replicate/);
  });

  for (const [label, argv] of [
    ['an unknown provider', ['config', 'get-key', 'nope']],
    ['a missing provider', ['config', 'get-key']],
    ['extra arguments', ['config', 'get-key', 'kie', 'fal']],
  ]) {
    test(`${label} is a usage error`, async (t) => {
      const e = createEnvironment(t, { env: keysFor('kie', 'fal') });
      assert.equal((await e.run(argv)).code, 2);
    });
  }

  for (const provider of ORDER) {
    test(`the full ${provider} key is never printed but its last four characters show`, async (t) => {
      const e = createEnvironment(t, { env: keysFor(provider) });
      const key = KEYS[ENV_NAME[provider]];
      for (const argv of [['config', 'get-key', provider], ['config', 'get-key', provider, '--json']]) {
        const r = await e.run(argv);
        assert.equal(r.code, 0, allText(r));
        assert.ok(!allText(r).includes(key), `${argv.join(' ')} leaked the key`);
        assert.ok(r.stdout.includes(`****${key.slice(-4)}`), `${argv.join(' ')} should show the mask`);
      }
    });
  }
});

describe('help text', () => {
  test('--help mentions set-key, get-key and list', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['--help']);
    for (const word of ['set-key', 'get-key', 'list']) assert.ok(r.stdout.includes(word), `help should mention ${word}`);
  });

  test('an unknown config subcommand shows usage naming set-key, get-key and list', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['config', 'bogus']);
    assert.equal(r.code, 2);
    for (const word of ['set-key', 'get-key', 'list']) assert.ok(allText(r).includes(word), `usage should mention ${word}`);
  });
});

describe('readSecret', () => {
  const tick = () => new Promise((r) => setImmediate(r));
  function fakeTty() {
    const input = new PassThrough();
    input.isTTY = true;
    input.rawModes = [];
    input.setRawMode = (v) => { input.rawModes.push(v); return input; };
    let out = '';
    const output = { write(s) { out += s; return true; } };
    return { input, output, written: () => out };
  }
  async function start(opts = {}) {
    const { readSecret } = await import('../src/cli/prompt.js');
    const tty = fakeTty();
    const before = tty.input.listenerCount('data');
    const promise = readSecret({ input: tty.input, output: tty.output, label: 'Kie API key: ', ...opts });
    await tick();
    const type = async (s) => { tty.input.write(s); await tick(); };
    return { ...tty, before, promise, type };
  }

  test('resolves to the typed text on carriage return and never writes the characters', async () => {
    const s = await start();
    await s.type('sec');
    await s.type('ret-Key');
    await s.type('\r');
    assert.equal(await s.promise, 'secret-Key');
    assert.ok(s.written().includes('Kie API key: '));
    assert.ok(!/secret|Key/.test(s.written().replace('Kie API key: ', '')), 'typed characters must not be echoed');
  });

  test('a newline also ends the line', async () => {
    const s = await start();
    await s.type('abc\n');
    assert.equal(await s.promise, 'abc');
  });

  test('a key pasted in one chunk with a trailing CRLF works', async () => {
    const s = await start();
    await s.type('pasted-key-1234\r\n');
    assert.equal((await s.promise).trim(), 'pasted-key-1234');
  });

  test('backspace (DEL and BS) deletes the last character; on empty input it is harmless', async () => {
    const s = await start();
    await s.type('\x7f\b');
    await s.type('abcd');
    await s.type('\x7f');
    await s.type('\be');
    await s.type('\r');
    assert.equal(await s.promise, 'abe');
  });

  test('bracketed-paste markers and arrow-key sequences are ignored', async () => {
    const s = await start();
    await s.type('\x1b[200~pasted-key\x1b[201~');
    await s.type('\x1b[A\x1b[B\x1b[C\x1b[D');
    await s.type('-2\r');
    assert.equal(await s.promise, 'pasted-key-2');
  });

  test('Ctrl+C resolves null even after some text', async () => {
    const s = await start();
    await s.type('abc');
    await s.type('\x03');
    assert.equal(await s.promise, null);
  });

  test('Ctrl+D on empty input resolves null', async () => {
    const s = await start();
    await s.type('\x04');
    assert.equal(await s.promise, null);
  });

  test('a stream that ends before Enter resolves null', async () => {
    const s = await start();
    await s.type('partial');
    s.input.end();
    assert.equal(await s.promise, null);
  });

  test('raw mode is on while reading and off afterwards, listeners removed, input paused', async () => {
    const s = await start();
    assert.deepEqual(s.input.rawModes, [true]);
    assert.ok(s.input.listenerCount('data') > s.before, 'should be listening while reading');
    await s.type('k\r');
    await s.promise;
    assert.deepEqual(s.input.rawModes, [true, false]);
    assert.equal(s.input.listenerCount('data'), s.before);
    assert.equal(s.input.isPaused(), true);
  });

  for (const [label, finish] of [
    ['Ctrl+C', (s) => s.type('\x03')],
    ['Ctrl+D', (s) => s.type('\x04')],
    ['end of stream', async (s) => { s.input.end(); await tick(); }],
  ]) {
    test(`raw mode is restored and listeners removed after ${label}`, async () => {
      const s = await start();
      await finish(s);
      await s.promise;
      assert.equal(s.input.rawModes.at(-1), false);
      assert.equal(s.input.rawModes.filter((v) => v === true).length, 1);
      assert.equal(s.input.listenerCount('data'), s.before);
    });
  }
});
