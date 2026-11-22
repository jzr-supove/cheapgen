// Test harness: runs the CLI in-process with everything injected (see the test contract:
// env, fetch, stdout, stderr, stdin, homedir, cwd, now, sleep, dataDir). Temp dirs are
// created per test and removed afterwards. Never touches the network or real home dir.
//
// io.sleep(ms) is part of the contract: polling waits go through it, and here it advances
// the fake clock returned by io.now(), so a 15-minute wait timeout runs instantly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createFakeFetch } from './fake-fetch.js';

export const DATA_DIR = fileURLToPath(new URL('../fixtures/data/', import.meta.url));
export const DEFAULT_NOW = '2026-11-21T12:00:00Z';

// Obviously fake keys, distinct per provider, in each provider's real format.
export const KEYS = {
  KIE_API_KEY: 'test-kie-key-AAAA1111',
  REPLICATE_API_TOKEN: 'r8_TESTreplicateKEYbbbb2222',
  WAVESPEED_API_KEY: 'test-wavespeed-key-CCCC3333',
  FAL_KEY: 'test-fal-id:test-fal-secret-DDDD4444',
};
export const KEY_ENV = { kie: 'KIE_API_KEY', replicate: 'REPLICATE_API_TOKEN', wavespeed: 'WAVESPEED_API_KEY', fal: 'FAL_KEY' };
export const keysFor = (...providers) => Object.fromEntries(providers.map((p) => [KEY_ENV[p], KEYS[KEY_ENV[p]]]));

const tryJson = (s) => {
  const t = s.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
};

export const approx = (actual, expected, eps = 1e-6, msg) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < eps,
    msg ?? `expected ${actual} to be within ${eps} of ${expected}`);

/** All leaf values of a JSON structure, as strings. Used to check explicit request values
 *  without knowing each provider's field names. */
export function leafValues(x, out = []) {
  if (x !== null && typeof x === 'object') for (const v of Object.values(x)) leafValues(v, out);
  else if (x !== undefined && x !== null) out.push(String(x));
  return out;
}

export function walkFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) files.push(...walkFiles(p));
    else files.push(p);
  }
  return files;
}

/**
 * @param t        node:test context (for cleanup)
 * @param opts     { env, routes, userConfig, projectConfig, now, dataDir }
 */
export function createEnvironment(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapgen-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapgen-cwd-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const fake = createFakeFetch(opts.routes ?? []);
  const clock = { ms: new Date(opts.now ?? DEFAULT_NOW).getTime() };
  const transcript = [];
  const env = { ...(opts.env ?? {}) };

  const api = {
    home, cwd, fake, calls: fake.calls, env, clock,
    spendPath: path.join(home, '.cheapgen', 'spend.jsonl'),
    userConfigPath: path.join(home, '.cheapgen', 'config.json'),
    projectConfigPath: path.join(cwd, '.cheapgen.json'),

    setNow(when) { clock.ms = new Date(when).getTime(); },
    setRoutes(routes) { fake.setRoutes(routes); },
    writeUserConfig(obj, file = api.userConfigPath) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
    },
    writeProjectConfig(obj) { fs.writeFileSync(api.projectConfigPath, JSON.stringify(obj, null, 2)); },
    writeSpendLines(lines) {
      fs.mkdirSync(path.dirname(api.spendPath), { recursive: true });
      fs.writeFileSync(api.spendPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    },
    spendText() { return fs.existsSync(api.spendPath) ? fs.readFileSync(api.spendPath, 'utf8') : ''; },
    spendLines() {
      return api.spendText().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    /** Everything printed by every run so far (stdout and stderr). */
    allOutput() { return transcript.join('\n'); },

    /** Runs the CLI. Returns { code, stdout, stderr, json, error, calls }. */
    async run(argv, extra = {}) {
      const { main } = await import('../../src/cli/main.js');
      let stdout = '';
      let stderr = '';
      const io = {
        env: { ...env, ...(extra.env ?? {}) },
        fetch: fake.fetch,
        stdout: { write(s) { stdout += s; return true; } },
        stderr: { write(s) { stderr += s; return true; } },
        homedir: home,
        cwd,
        now: () => new Date(clock.ms),
        sleep: async (ms) => { clock.ms += ms; },
        dataDir: opts.dataDir ?? DATA_DIR,
      };
      if (extra.stdin !== undefined) io.stdin = extra.stdin;
      if (extra.promptSecret !== undefined) {
        io.promptSecret = extra.promptSecret;
        // Never fall back to reading the real process stdin if a command ignores the prompt.
        if (io.stdin === undefined) io.stdin = '';
      }
      const code = await main(argv, io);
      transcript.push(stdout, stderr);
      fake.assertClean();
      assert.equal(typeof code, 'number', 'main() must resolve to a numeric exit code');
      const json = tryJson(stdout) ?? tryJson(stderr);
      return { code, stdout, stderr, json, error: json?.error ?? null, calls: fake.calls };
    },
  };

  if (opts.userConfig) api.writeUserConfig(opts.userConfig);
  if (opts.projectConfig) api.writeProjectConfig(opts.projectConfig);
  return api;
}

export const PROMPT = 'a calm lake at dawn';
/** argv for a text-to-video / text-to-image run with --json. */
export const runArgs = (model, ...extra) => ['run', model, '--prompt', PROMPT, '--json', ...extra];
export const quoteArgs = (model, ...extra) => ['quote', model, '--json', ...extra];
