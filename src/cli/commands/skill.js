// `cheapgen skill install|uninstall|path`: copy the bundled agent skill into the folders that
// Claude Code, Codex, Cursor and other Agent Skills clients read.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, usageError } from '../../errors.js';

export const BUNDLED_SKILL = fileURLToPath(new URL('../../../skills/cheapgen/', import.meta.url)).replace(/[\\/]$/, '');
const NAME = 'cheapgen';

/** Where each agent reads skills, relative to the home folder or the project folder. */
const TARGETS = {
  claude: path.join('.claude', 'skills'),
  codex: path.join('.agents', 'skills'),
  cursor: path.join('.cursor', 'skills'),
};
const AGENTS = Object.keys(TARGETS);
const CHOICES = `--agent ${AGENTS.join('|')}`;
const USAGE = 'cheapgen skill install|uninstall|path [--agent claude|codex|cursor] [--project]';

export async function skill(app) {
  const [sub, ...rest] = app.args;
  if (rest.length) throw usageError(`too many arguments. Usage: ${USAGE}`);
  if (sub === 'path') return showPath(app);
  if (sub === 'install') return install(app);
  if (sub === 'uninstall') return uninstall(app);
  throw usageError(`${sub ? `unknown skill command "${sub}"` : 'missing a skill command'}. Usage: ${USAGE}`);
}

function showPath(app) {
  app.out.result({ path: BUNDLED_SKILL }, BUNDLED_SKILL);
  return EXIT.OK;
}

/** The agents named with --agent (repeatable, comma-separated), or null when none were given. */
function namedAgents(app) {
  const raw = [app.flags.agent ?? []].flat();
  if (!raw.length) return null;
  const names = raw.flatMap((v) => String(v).split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = names.filter((n) => !AGENTS.includes(n));
  if (bad.length || !names.length) {
    throw usageError(`unknown agent "${bad[0] ?? ''}". Choose ${AGENTS.join(', ')} (${CHOICES}).`);
  }
  return [...new Set(names)];
}

/** Agents to act on: the named ones, or the ones whose folders exist. */
function chosenAgents(app) {
  const named = namedAgents(app);
  if (named) return named;
  if (app.flags.project) return ['claude', 'codex'];
  const home = app.io.homedir;
  const has = (dir) => fs.existsSync(path.join(home, dir));
  const found = [];
  if (has('.claude')) found.push('claude');
  if (has('.codex') || has('.agents') || has('.cursor')) found.push('codex');
  if (!found.length) {
    throw usageError(`no agent folder found (~/.claude, ~/.codex, ~/.agents or ~/.cursor). Choose one with ${CHOICES}.`);
  }
  return found;
}

const targetOf = (app, agent) => path.join(app.flags.project ? app.io.cwd : app.io.homedir, TARGETS[agent], NAME);

/** 'missing' | 'link' | 'ours' | 'other' */
function inspect(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return 'missing'; }
  if (st.isSymbolicLink()) return 'link';
  if (!st.isDirectory()) return 'other';
  return isCheapgenSkill(path.join(dir, 'SKILL.md')) ? 'ours' : 'other';
}

function isCheapgenSkill(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return /^name:\s*["']?cheapgen["']?\s*$/m.test(front);
}

function refuse(dir, state) {
  const why = state === 'link' ? 'is a link, which cheapgen won\'t follow or replace'
    : 'already exists and isn\'t a cheapgen skill';
  return usageError(`${dir} ${why}. Nothing was changed; move it away first.`);
}

function install(app) {
  const plan = chosenAgents(app).map((agent) => {
    const dir = targetOf(app, agent);
    return { agent, dir, state: inspect(dir) };
  });
  // All or nothing: check every target before writing any.
  for (const p of plan) if (p.state === 'link' || p.state === 'other') throw refuse(p.dir, p.state);

  const installed = [];
  for (const { agent, dir, state } of plan) {
    if (state === 'ours') fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(BUNDLED_SKILL, dir, { recursive: true });
    installed.push({ agent, path: dir, replaced: state === 'ours' });
  }
  const text = installed.map((i) => `${i.replaced ? 'replaced' : 'installed'} ${i.agent} skill: ${i.path}`).join('\n');
  app.out.result({ installed }, text);
  return EXIT.OK;
}

function uninstall(app) {
  const plan = chosenAgents(app).map((agent) => {
    const dir = targetOf(app, agent);
    return { agent, dir, state: inspect(dir) };
  });
  for (const p of plan) if (p.state === 'link' || p.state === 'other') throw refuse(p.dir, p.state);

  const removed = [];
  for (const { agent, dir, state } of plan) {
    if (state !== 'ours') continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push({ agent, path: dir });
  }
  const text = removed.length ? removed.map((r) => `removed ${r.agent} skill: ${r.path}`).join('\n')
    : 'No cheapgen skill was installed there.';
  app.out.result({ removed }, text);
  return EXIT.OK;
}
