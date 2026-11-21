// scripts/price-check-report.js turns `prices --check --json` output into an issue body.
// No network: the CLI output used in the last block comes from the fake fetch in the harness.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEnvironment } from './helpers/harness.js';
import { DESC, row, kieRoutes } from './helpers/kie-price-list.js';

const SCRIPT = fileURLToPath(new URL('../scripts/price-check-report.js', import.meta.url));
const DATA_LIVE = fileURLToPath(new URL('./fixtures/data-live/', import.meta.url));
const buildReport = async (check) => (await import(pathToFileURL(SCRIPT).href)).buildReport(check);

const ENV_NAMES = ['KIE_API_KEY', 'REPLICATE_API_TOKEN', 'WAVESPEED_API_KEY', 'FAL_KEY'];
const lines = (s) => s.split('\n');
const tableRowsWith = (body, ...needles) =>
  lines(body).filter((l) => l.trimStart().startsWith('|') && needles.every((n) => l.includes(n)));

const res = (o) => ({ provider: 'kie', model: 'm', mode: 'video', when: {}, bundledUsd: 0.01, liveUsd: 0.01,
  unit: 'per second', status: 'same', reason: undefined, ...o });
const summarize = (results) => {
  const s = { same: 0, changed: 0, missing: 0, unavailable: 0, unchecked: 0 };
  for (const r of results) s[r.status]++;
  return s;
};
const check = (results, extra = {}) => ({ checkedOn: '2026-11-21T06:00:00.000Z', results, summary: summarize(results), stale: [], ...extra });

const CHANGED_UP = res({ provider: 'kie', model: 'seedance-2.0-mini', when: { resolution: '480p' },
  bundledUsd: 0.041, liveUsd: 0.045, unit: 'per second', status: 'changed' });
const CHANGED_DOWN = res({ provider: 'fal', model: 'seedream-5-pro', mode: 'image', when: { size: '1K' },
  bundledUsd: 0.05, liveUsd: 0.045, unit: 'per image', status: 'changed' });
const MISSING = res({ provider: 'kie', model: 'gone-model', when: { resolution: '720p' }, status: 'missing',
  liveUsd: null, reason: 'no matching row in the live price list' });
const UNAVAILABLE = res({ provider: 'wavespeed', model: 'flaky-model', status: 'unavailable', liveUsd: null,
  reason: 'price request failed (503)' });
const unchecked = (n, provider, reason, model) => Array.from({ length: n }, (_, i) =>
  res({ provider, model, when: { n: i }, status: 'unchecked', liveUsd: null, reason }));

describe('attention', () => {
  test('false when nothing changed or is missing, even with unavailable and many unchecked rows', async () => {
    const results = [res({}), UNAVAILABLE, ...unchecked(40, 'replicate', 'no price API', 'rep-model')];
    const r = await buildReport(check(results));
    assert.equal(r.attention, false);
  });
  test('true when a price changed', async () => {
    assert.equal((await buildReport(check([res({}), CHANGED_UP]))).attention, true);
  });
  test('true when a row is missing', async () => {
    assert.equal((await buildReport(check([res({}), MISSING]))).attention, true);
  });
  test('returns title and body strings', async () => {
    const r = await buildReport(check([CHANGED_UP]));
    assert.equal(typeof r.title, 'string');
    assert.equal(typeof r.body, 'string');
    assert.ok(r.title.length > 0 && r.body.length > 0);
  });
});

describe('body: changed rows', () => {
  const build = () => buildReport(check([res({}), CHANGED_UP, CHANGED_DOWN]));

  test('each changed row is a table row with provider, model, options, both prices and the unit', async () => {
    const { body } = await build();
    const up = tableRowsWith(body, 'kie', 'seedance-2.0-mini', '480p', '0.041', '0.045', 'per second');
    assert.equal(up.length, 1, body);
    const down = tableRowsWith(body, 'fal', 'seedream-5-pro', '1K', '0.05', '0.045', 'per image');
    assert.equal(down.length, 1, body);
  });

  test('shows the relative change with its sign', async () => {
    const { body } = await build();
    assert.match(tableRowsWith(body, 'seedance-2.0-mini')[0], /\+9\.8\s?%/);
    assert.match(tableRowsWith(body, 'seedream-5-pro')[0], /-10(\.0)?\s?%/);
  });

  test('rows that are the same do not appear as changed rows', async () => {
    const { body } = await buildReport(check([res({ model: 'steady-model' }), CHANGED_UP]));
    assert.equal(tableRowsWith(body, 'steady-model').length, 0);
  });
});

describe('body: the rest', () => {
  const results = [
    CHANGED_UP, MISSING, UNAVAILABLE,
    ...unchecked(30, 'replicate', 'no price API', 'rep-unchecked-model'),
    ...unchecked(12, 'fal', 'needs a key', 'fal-unchecked-model'),
    ...unchecked(5, 'fal', 'unit "per megapixel" does not fit', 'fal-unchecked-model'),
  ];
  const stale = [{ provider: 'replicate', model: 'a', verifiedOn: '2026-10-01' },
    { provider: 'replicate', model: 'b', verifiedOn: '2026-10-02' },
    { provider: 'fal', model: 'c', verifiedOn: '2026-10-03' }];
  const build = () => buildReport(check(results, { stale }));

  test('lists missing and unavailable rows with their reasons', async () => {
    const { body } = await build();
    assert.equal(tableRowsWith(body, 'kie', 'gone-model', 'no matching row in the live price list').length, 1, body);
    assert.equal(tableRowsWith(body, 'wavespeed', 'flaky-model', 'price request failed (503)').length, 1, body);
  });

  test('unchecked rows are counted per provider and reason, not listed one by one', async () => {
    const { body } = await build();
    assert.ok(!body.includes('rep-unchecked-model'), 'no per-row lines for unchecked rows');
    assert.ok(!body.includes('fal-unchecked-model'));
    const find = (...n) => lines(body).filter((l) => n.every((x) => l.includes(x)));
    assert.equal(find('replicate', 'no price API', '30').length, 1, body);
    assert.equal(find('fal', 'needs a key', '12').length, 1, body);
    assert.equal(find('fal', 'does not fit', '5').length, 1, body);
  });

  test('includes the stale count and the check date', async () => {
    const { body } = await build();
    assert.ok(lines(body).some((l) => /stale/i.test(l) && /\b3\b/.test(l)), body);
    assert.ok(body.includes('2026-11-21'));
  });

  test('includes the summary counts', async () => {
    const { body } = await build();
    assert.ok(lines(body).some((l) => /changed/i.test(l) && /\b1\b/.test(l)), body);
    assert.ok(lines(body).some((l) => /unchecked/i.test(l) && /\b47\b/.test(l)), body);
  });
});

describe('safety and title', () => {
  test('never mentions key environment variables, even when a reason says "needs a key"', async () => {
    const results = [CHANGED_UP, MISSING,
      res({ provider: 'wavespeed', model: 'k1', status: 'unavailable', reason: 'needs a key' }),
      ...unchecked(3, 'wavespeed', 'needs a key', 'k2'), ...unchecked(3, 'fal', 'needs a key', 'k3')];
    const r = await buildReport(check(results));
    for (const name of ENV_NAMES) {
      assert.ok(!r.body.includes(name), `body has ${name}`);
      assert.ok(!r.title.includes(name), `title has ${name}`);
    }
    assert.match(r.body, /needs a key/);
  });

  test('title mentions prices and the date', async () => {
    const { title } = await buildReport(check([CHANGED_UP]));
    assert.match(title, /price/i);
    assert.ok(title.includes('2026-11-21'), title);
  });
});

describe('command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcr-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (inFile, outFile, env = {}) => spawnSync(process.execPath, [SCRIPT, inFile, outFile], {
    encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
  });
  const put = (name, content) => { const p = join(dir, name); writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content)); return p; };

  test('valid input: exit 0, writes the body, prints attention=true', async () => {
    const data = check([CHANGED_UP, res({})]);
    const out = join(dir, 'r1.md');
    const p = run(put('c1.json', data), out);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^attention=true$/m);
    assert.equal(readFileSync(out, 'utf8').trim(), (await buildReport(data)).body.trim());
  });

  test('valid input with nothing to report prints attention=false', () => {
    const out = join(dir, 'r2.md');
    const p = run(put('c2.json', check([res({}), UNAVAILABLE])), out);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^attention=false$/m);
    assert.ok(existsSync(out));
  });

  test('appends the body to GITHUB_STEP_SUMMARY when set', () => {
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, 'existing line\n');
    const out = join(dir, 'r3.md');
    const p = run(put('c3.json', check([CHANGED_UP])), out, { GITHUB_STEP_SUMMARY: summary });
    assert.equal(p.status, 0, p.stderr);
    const text = readFileSync(summary, 'utf8');
    assert.ok(text.startsWith('existing line\n'), 'appended, not overwritten');
    assert.ok(text.includes(readFileSync(out, 'utf8').trim()));
  });

  const bad = {
    'a missing input file': () => join(dir, 'does-not-exist.json'),
    'input that is not JSON': () => put('bad1.json', 'this is not json {'),
    'an { error } object': () => put('bad2.json', { error: { code: 'x', message: 'boom' } }),
    'input without summary': () => put('bad3.json', { checkedOn: '2026-11-21', results: [], stale: [] }),
    'input without results': () => put('bad4.json', { checkedOn: '2026-11-21', summary: { same: 0, changed: 0, missing: 0, unavailable: 0, unchecked: 0 }, stale: [] }),
  };
  for (const [name, make] of Object.entries(bad)) {
    test(`exits 1 and writes no report for ${name}`, () => {
      const out = join(dir, `out-${name.replace(/\W+/g, '-')}.md`);
      const summary = join(dir, `sum-${name.replace(/\W+/g, '-')}.md`);
      const p = run(make(), out, { GITHUB_STEP_SUMMARY: summary });
      assert.equal(p.status, 1);
      assert.doesNotMatch(p.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, 'script must exist and reject the input itself');
      assert.ok(!existsSync(out), 'no report file');
      assert.ok(!existsSync(summary), 'job summary untouched');
      assert.doesNotMatch(p.stdout, /attention=/);
    });
  }
});

describe('real CLI output', () => {
  const KIE_ROWS = [row(DESC.mini480, { usd: 0.01905 }), row(DESC.mini720, { usd: 0.045 })];
  const cliCheck = async (t, kie) => {
    const e = await createEnvironment(t, { dataDir: DATA_LIVE, routes: kieRoutes(kie) });
    const r = await e.run(['prices', '--check', '--json']);
    assert.equal(r.code, 0, r.stderr);
    return r.json;
  };

  test('accepts the CLI JSON; attention follows the summary and the changed row is reported', async (t) => {
    const json = await cliCheck(t, KIE_ROWS);
    assert.deepEqual(json.summary, { same: 1, changed: 1, missing: 1, unavailable: 0, unchecked: 4 });
    const r = await buildReport(json);
    assert.equal(r.attention, true);
    assert.equal(tableRowsWith(r.body, 'kie', 'seedance-2.0-mini', '720p', '0.041', '0.045', '+9.8').length, 1, r.body);
    assert.ok(r.body.includes('2026-11-21'));
    for (const name of ENV_NAMES) assert.ok(!r.body.includes(name), name);
  });

  test('attention is false when the live list matches and nothing is missing', async (t) => {
    const json = await cliCheck(t, [row(DESC.mini480, { usd: 0.019 }), row(DESC.mini720, { usd: 0.041 }),
      row(DESC.pro1k, { usd: 0.035, unit: 'per image' })]);
    const r = await buildReport(json);
    assert.equal(r.attention, json.summary.changed > 0 || json.summary.missing > 0);
  });

  test('a failed Kie list (all unavailable) does not raise attention', async (t) => {
    const e = await createEnvironment(t, { dataDir: DATA_LIVE, routes: kieRoutes({ status: 503, json: { code: 503 } }) });
    const json = (await e.run(['prices', '--check', '--json'])).json;
    assert.equal(json.summary.unavailable, 3);
    assert.equal((await buildReport(json)).attention, false);
  });
});
