#!/usr/bin/env node
// Turns `cheapgen prices --check --json` output into the weekly price-check issue.
//
//   node scripts/price-check-report.js <check.json> <report.md>
//
// Writes the issue body to <report.md>, appends it to $GITHUB_STEP_SUMMARY when set, and prints
// `attention=true|false` and `title=...` lines for $GITHUB_OUTPUT. Exits 1 and writes nothing when
// the input isn't a usable check result, so a broken check fails the job instead of looking clean.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// The report may be posted publicly: never name the variables that hold keys.
const KEY_VARS = /\b(KIE_API_KEY|REPLICATE_API_TOKEN|WAVESPEED_API_KEY|FAL_KEY)\b/g;
const clean = (s) => String(s ?? '').replace(KEY_VARS, 'its key').replace(/\r?\n/g, ' ');
const cell = (s) => clean(s).replace(/\|/g, '\\|');

const options = (when) => Object.values(when ?? {}).flat().join(' / ') || 'any';
const price = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(Number(n.toPrecision(6))) : '—');

function relativeChange(from, to) {
  if (typeof from !== 'number' || typeof to !== 'number' || from === 0) return '—';
  const pct = ((to - from) / from) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/**
 * @param {{ checkedOn: string, results: object[], summary: object, stale?: object[] }} check
 * @returns {{ attention: boolean, title: string, body: string }}
 */
export function buildReport(check) {
  const { summary, results } = check;
  const date = String(check.checkedOn ?? '').slice(0, 10) || 'unknown date';
  const attention = (summary.changed ?? 0) > 0 || (summary.missing ?? 0) > 0;
  const stale = Array.isArray(check.stale) ? check.stale.length : 0;

  const lines = [
    `Weekly price check, ${date}.`,
    '',
    `- same: ${summary.same ?? 0}`,
    `- changed: ${summary.changed ?? 0}`,
    `- missing: ${summary.missing ?? 0}`,
    `- unavailable: ${summary.unavailable ?? 0}`,
    `- unchecked: ${summary.unchecked ?? 0}`,
    `- stale (bundled price older than 14 days): ${stale}`,
  ];

  const changed = results.filter((r) => r.status === 'changed');
  if (changed.length) {
    lines.push('', '### Changed', '', '| Provider | Model | Options | Bundled | Live | Unit | Change |',
      '|---|---|---|---|---|---|---|');
    for (const r of changed) {
      lines.push(`| ${cell(r.provider)} | ${cell(r.model)} | ${cell(options(r.when))} | ${price(r.bundledUsd)} `
        + `| ${price(r.liveUsd)} | ${cell(r.unit)} | ${relativeChange(r.bundledUsd, r.liveUsd)} |`);
    }
  }

  const problems = results.filter((r) => r.status === 'missing' || r.status === 'unavailable');
  if (problems.length) {
    lines.push('', '### Missing or unavailable', '', '| Status | Provider | Model | Options | Reason |', '|---|---|---|---|---|');
    for (const r of problems) {
      lines.push(`| ${r.status} | ${cell(r.provider)} | ${cell(r.model)} | ${cell(options(r.when))} | ${cell(r.reason)} |`);
    }
  }

  const unchecked = new Map();
  for (const r of results.filter((x) => x.status === 'unchecked')) {
    const key = `${clean(r.provider)}: ${clean(r.reason) || 'no reason given'}`;
    unchecked.set(key, (unchecked.get(key) ?? 0) + 1);
  }
  if (unchecked.size) {
    lines.push('', '### Not checked', '');
    for (const [key, n] of unchecked) lines.push(`- ${key} (${n})`);
  }

  lines.push('', 'Update `data/prices.json` (the price and `verifiedOn`) from the provider\'s own page, '
    + 'then close this issue. Prices are estimates; each provider\'s bill is authoritative.');

  const title = clean(attention
    ? `Price check ${date}: ${summary.changed ?? 0} changed, ${summary.missing ?? 0} missing`
    : `Price check ${date}: no price changes`);
  return { attention, title, body: `${lines.join('\n')}\n` };
}

function readCheck(file) {
  let check;
  try {
    check = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`can't read ${file}: ${err.code ?? err.message}`);
  }
  if (!check || typeof check !== 'object' || check.error) {
    throw new Error(`${file} is an error result: ${clean(check?.error?.message ?? 'no details')}`);
  }
  if (!check.summary || typeof check.summary !== 'object' || !Array.isArray(check.results)) {
    throw new Error(`${file} has no summary or results; is it \`prices --check --json\` output?`);
  }
  return check;
}

function cli(argv) {
  const [input, output] = argv;
  if (!input || !output) {
    process.stderr.write('usage: node scripts/price-check-report.js <check.json> <report.md>\n');
    return 1;
  }
  let report;
  try {
    report = buildReport(readCheck(input));
  } catch (err) {
    process.stderr.write(`price-check-report: ${err.message}\n`);
    return 1;
  }
  fs.writeFileSync(output, report.body);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.body);
  process.stdout.write(`attention=${report.attention}\ntitle=${report.title}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
