// Plugin manifests for Claude Code, Codex, GitHub Copilot, Cursor, Antigravity CLI and Gemini CLI: they parse, carry the package version,
// point at files that exist, start the MCP server the same way, and pass provider keys only
// through settings the app keeps secret.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const pkg = read('package.json');
const START = { command: 'npx', args: ['-y', 'cheapgen@latest', 'mcp'] };
const KEY_VARS = ['KIE_API_KEY', 'REPLICATE_API_TOKEN', 'WAVESPEED_API_KEY', 'FAL_KEY'];

const claude = read('.claude-plugin/plugin.json');
const claudeMarket = read('.claude-plugin/marketplace.json');
const codex = read('.codex-plugin/plugin.json');
const codexMarket = read('.agents/plugins/marketplace.json');
const codexMcp = read('mcp.json');
const gemini = read('gemini-extension.json');
const cursor = exists('.cursor-plugin/plugin.json') ? read('.cursor-plugin/plugin.json') : {};
const cursorMarket = exists('.cursor-plugin/marketplace.json') ? read('.cursor-plugin/marketplace.json') : { plugins: [] };
const portable = exists('plugin.json') ? read('plugin.json') : {};
const AGENT_PLUGINS = 'https://agent-plugins.org/schemas/1.0.0/';
const PORTABLE_FIELDS = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
const antigravity = exists('.antigravity-plugin/plugin.json') ? read('.antigravity-plugin/plugin.json') : {};
const antigravityMcp = exists('mcp_config.json') ? read('mcp_config.json') : { mcpServers: {} };
const ANTIGRAVITY_FIELDS = ['$schema', 'name', 'displayName', 'description', 'version', 'logo', 'suggestedPrompts', 'skills',
  'disabled', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];

describe('every manifest', () => {
  for (const [file, m] of [['.claude-plugin/plugin.json', claude], ['.codex-plugin/plugin.json', codex], ['plugin.json', portable], ['.cursor-plugin/plugin.json', cursor],
    ['.antigravity-plugin/plugin.json', antigravity], ['gemini-extension.json', gemini]]) {
    test(`${file} is named cheapgen and has the package version`, () => {
      assert.equal(m.name, 'cheapgen');
      assert.equal(m.version, pkg.version, 'bump the plugin versions with package.json');
      assert.equal(typeof m.description, 'string');
    });
  }

  test('each starts the MCP server with the same command', () => {
    for (const [label, s] of [['claude', claude.mcpServers.cheapgen], ['codex', codexMcp.mcpServers.cheapgen],
      ['antigravity', antigravityMcp.mcpServers.cheapgen], ['gemini', gemini.mcpServers.cheapgen]]) {
      assert.ok(s, `${label} declares the cheapgen server`);
      assert.equal(s.command, START.command, label);
      assert.deepEqual(s.args, START.args, label);
    }
  });

  test('the bundled skill exists where the plugins look for it', () => {
    assert.ok(exists('skills/cheapgen/SKILL.md'));
    assert.match(fs.readFileSync(path.join(ROOT, 'skills/cheapgen/SKILL.md'), 'utf8'), /^---\r?\nname: cheapgen\r?\n/);
  });

  test('none of them is shipped in the npm package', () => {
    for (const f of ['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.antigravity-plugin', '.agents', 'plugin.json', 'mcp.json', 'mcp_config.json', 'gemini-extension.json']) {
      assert.ok(!pkg.files.some((p) => p.replace(/\/$/, '') === f), f);
    }
  });

  test('no manifest holds anything that looks like a key', () => {
    for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json',
      '.agents/plugins/marketplace.json', 'mcp.json', 'plugin.json', '.cursor-plugin/plugin.json', '.cursor-plugin/marketplace.json', '.antigravity-plugin/plugin.json', 'mcp_config.json', 'gemini-extension.json']) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.doesNotMatch(text, /r8_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|"(KIE_API_KEY|REPLICATE_API_TOKEN|WAVESPEED_API_KEY|FAL_KEY)":\s*"[^$"]/, f);
    }
  });
});

describe('Claude Code', () => {
  test('the marketplace lists the plugin at the repo root under the same name', () => {
    assert.equal(claudeMarket.name, 'cheapgen');
    assert.equal(typeof claudeMarket.owner?.name, 'string');
    assert.equal(claudeMarket.plugins.length, 1);
    assert.equal(claudeMarket.plugins[0].name, claude.name);
    assert.equal(claudeMarket.plugins[0].source, './');
  });

  test('each provider key comes from an optional secret setting', () => {
    const env = claude.mcpServers.cheapgen.env;
    assert.deepEqual(Object.keys(env).sort(), [...KEY_VARS].sort());
    for (const [v, ref] of Object.entries(env)) {
      const key = /^\$\{user_config\.([a-z_]+)\}$/.exec(ref)?.[1];
      assert.ok(key, `${v} is filled from a user setting`);
      const opt = claude.userConfig[key];
      assert.ok(opt, `${key} is declared`);
      assert.equal(opt.type, 'string');
      assert.equal(opt.sensitive, true, `${key} is kept secret`);
      assert.notEqual(opt.required, true, `${key} is optional`);
      assert.equal(typeof opt.title, 'string');
      assert.equal(typeof opt.description, 'string');
    }
  });
});

describe('Codex', () => {
  test('the plugin points at the skill folder and the MCP file, and both exist', () => {
    for (const p of [codex.skills, codex.mcpServers]) {
      assert.match(p, /^\.\//);
      assert.ok(exists(p), p);
    }
    assert.equal(path.posix.normalize(codex.mcpServers), 'mcp.json');
  });

  test('the MCP file declares one stdio server', () => {
    assert.deepEqual(Object.keys(codexMcp.mcpServers), ['cheapgen']);
    assert.equal(codexMcp.mcpServers.cheapgen.type, 'stdio');
  });

  test('the marketplace lists the plugin at the repo root under the same name', () => {
    assert.equal(codexMarket.name, 'cheapgen');
    assert.equal(codexMarket.plugins.length, 1);
    assert.equal(codexMarket.plugins[0].name, codex.name);
    assert.deepEqual(codexMarket.plugins[0].source, { source: 'local', path: './' });
  });
});

describe('GitHub Copilot (Agent Plugins 1.0 at the repo root)', () => {
  test('plugin.json uses the Agent Plugins 1.0 schema and only its fields', () => {
    assert.equal(portable.$schema, `${AGENT_PLUGINS}plugin.schema.json`);
    for (const k of Object.keys(portable)) assert.ok(PORTABLE_FIELDS.includes(k), `unknown field ${k}`);
    assert.match(portable.name, /^[a-z0-9.-]{1,64}$/);
  });

  test('mcp.json names the matching MCP schema', () => {
    assert.equal(codexMcp.$schema, `${AGENT_PLUGINS}mcp.schema.json`);
  });
});

describe('Cursor', () => {
  test('the plugin has a kebab-case name and a display name', () => {
    assert.match(cursor.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof cursor.displayName, 'string');
  });

  test('the server comes from the root mcp.json, as a stdio server', () => {
    assert.equal(codexMcp.mcpServers.cheapgen.type, 'stdio');
    assert.equal(cursor.mcpServers, undefined, 'no second definition to drift');
  });

  test('the README "Add to Cursor" link starts the server the same way', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const link = /https:\/\/cursor\.com\/en\/install-mcp\?[^)\s]+/.exec(readme)?.[0];
    assert.ok(link, 'the README has an install link');
    const q = new URL(link).searchParams;
    assert.equal(q.get('name'), 'cheapgen');
    const config = JSON.parse(Buffer.from(q.get('config'), 'base64').toString('utf8'));
    assert.deepEqual(config, { command: [START.command, ...START.args].join(' ') });
  });

  test('the marketplace lists the plugin at the repo root under the same name', () => {
    assert.equal(typeof cursorMarket.name, 'string');
    assert.equal(typeof cursorMarket.owner?.name, 'string');
    assert.equal(cursorMarket.plugins.length, 1);
    assert.equal(cursorMarket.plugins[0].name, cursor.name);
    assert.equal(cursorMarket.plugins[0].source, './');
  });
});

describe('Antigravity CLI', () => {
  test('the manifest uses only documented fields and a valid plugin name', () => {
    for (const k of Object.keys(antigravity)) assert.ok(ANTIGRAVITY_FIELDS.includes(k), `unknown field ${k}`);
    assert.match(antigravity.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(antigravity.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
  });

  test('mcp_config.json declares one server and asks for no variables', () => {
    // Declared variables leave a plugin disabled until every one is filled in, and all keys are optional.
    assert.deepEqual(Object.keys(antigravityMcp.mcpServers), ['cheapgen']);
    assert.equal(antigravityMcp.mcpServers.cheapgen.variables, undefined);
  });

  test('the skill name matches its folder, as Antigravity requires', () => {
    const text = fs.readFileSync(path.join(ROOT, 'skills/cheapgen/SKILL.md'), 'utf8');
    assert.match(text, /^---\r?\nname: cheapgen\r?\n/);
  });
});

describe('Gemini CLI', () => {
  test('each provider key is a secret setting passed as its usual variable', () => {
    assert.deepEqual(gemini.settings.map((s) => s.envVar).sort(), [...KEY_VARS].sort());
    for (const s of gemini.settings) {
      assert.equal(s.sensitive, true, s.envVar);
      assert.equal(typeof s.name, 'string');
      assert.equal(typeof s.description, 'string');
    }
  });

  test('the context file, if named, exists', () => {
    if (gemini.contextFileName !== undefined) assert.ok(exists(gemini.contextFileName));
  });
});
