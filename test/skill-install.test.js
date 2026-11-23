// `cheapgen skill install | uninstall | path`: copies the bundled skill folder into agent skill
// folders under the (temp) home or current folder. No network, no keys.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvironment, walkFiles } from './helpers/harness.js';

const BUNDLED = fileURLToPath(new URL('../skills/cheapgen/', import.meta.url));
const REL_FILES = walkFiles(BUNDLED).map((f) => path.relative(BUNDLED, f)).sort();

const text = (r) => r.stdout + r.stderr;
const mk = (...parts) => fs.mkdirSync(path.join(...parts), { recursive: true });
const exists = (...parts) => fs.existsSync(path.join(...parts));

// Where each agent's copy lives, relative to a base folder (home or cwd).
const REL = {
  claude: ['.claude', 'skills', 'cheapgen'],
  codex: ['.agents', 'skills', 'cheapgen'],
  cursor: ['.cursor', 'skills', 'cheapgen'],
};
const dest = (base, agent) => path.join(base, ...REL[agent]);

function assertIdenticalToBundled(dir) {
  assert.ok(REL_FILES.includes('SKILL.md'), 'bundled skill has SKILL.md');
  const got = walkFiles(dir).map((f) => path.relative(dir, f)).sort();
  assert.deepEqual(got, REL_FILES, `files in ${dir}`);
  for (const rel of REL_FILES) {
    assert.ok(fs.readFileSync(path.join(dir, rel)).equals(fs.readFileSync(path.join(BUNDLED, rel))), `${rel} is byte-identical`);
  }
}

/** Every file under base, to prove "nothing was written". */
const snapshot = (base) => walkFiles(base).map((f) => path.relative(base, f)).sort();

const normPath = (p) => path.resolve(p).toLowerCase();
const entryFor = (list, agent) => list.find((x) => x.agent === agent);

describe('skill install with --agent', () => {
  for (const agent of ['claude', 'codex', 'cursor']) {
    test(`--agent ${agent} copies the bundled folder into the user folder`, async (t) => {
      const e = createEnvironment(t);
      const r = await e.run(['skill', 'install', '--agent', agent, '--json']);
      assert.equal(r.code, 0, text(r));
      assertIdenticalToBundled(dest(e.home, agent));
      assert.equal(r.json.installed.length, 1);
      const item = r.json.installed[0];
      assert.equal(item.agent, agent);
      assert.equal(normPath(item.path), normPath(dest(e.home, agent)));
      assert.equal(item.replaced, false);
      // Only the requested agent got a copy, and nothing went into the project folder.
      for (const other of ['claude', 'codex', 'cursor'].filter((a) => a !== agent)) {
        assert.ok(!exists(dest(e.home, other)), `${other} should not be installed`);
      }
      assert.deepEqual(snapshot(e.cwd), []);
      assert.equal(e.calls.length, 0);
    });
  }

  test('--agent claude,codex installs both', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install', '--agent', 'claude,codex', '--json']);
    assert.equal(r.code, 0, text(r));
    assertIdenticalToBundled(dest(e.home, 'claude'));
    assertIdenticalToBundled(dest(e.home, 'codex'));
    assert.ok(!exists(dest(e.home, 'cursor')));
    assert.deepEqual(r.json.installed.map((x) => x.agent).sort(), ['claude', 'codex']);
  });

  test('a repeated --agent installs both', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install', '--agent', 'claude', '--agent', 'codex', '--json']);
    assert.equal(r.code, 0, text(r));
    assertIdenticalToBundled(dest(e.home, 'claude'));
    assertIdenticalToBundled(dest(e.home, 'codex'));
    assert.deepEqual(r.json.installed.map((x) => x.agent).sort(), ['claude', 'codex']);
  });

  test('human output names each folder written', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install', '--agent', 'codex']);
    assert.equal(r.code, 0, text(r));
    assert.ok(r.stdout.includes(path.join('.agents', 'skills', 'cheapgen')), r.stdout);
    assert.doesNotMatch(r.stdout, /replaced/i, 'a first install is not a replacement');
  });
});

describe('skill install --project', () => {
  for (const agent of ['claude', 'codex', 'cursor']) {
    test(`--project --agent ${agent} installs under the current folder`, async (t) => {
      const e = createEnvironment(t);
      const r = await e.run(['skill', 'install', '--project', '--agent', agent, '--json']);
      assert.equal(r.code, 0, text(r));
      assertIdenticalToBundled(dest(e.cwd, agent));
      assert.equal(normPath(r.json.installed[0].path), normPath(dest(e.cwd, agent)));
      assert.deepEqual(snapshot(e.home), [], 'the home folder is untouched');
    });
  }

  test('--project with no --agent installs claude and codex, not cursor', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install', '--project', '--json']);
    assert.equal(r.code, 0, text(r));
    assertIdenticalToBundled(dest(e.cwd, 'claude'));
    assertIdenticalToBundled(dest(e.cwd, 'codex'));
    assert.ok(!exists(dest(e.cwd, 'cursor')));
    assert.deepEqual(r.json.installed.map((x) => x.agent).sort(), ['claude', 'codex']);
    assert.deepEqual(snapshot(e.home), []);
  });
});

describe('skill install without --agent (detection in the home folder)', () => {
  test('only ~/.claude exists: claude only', async (t) => {
    const e = createEnvironment(t);
    mk(e.home, '.claude');
    const r = await e.run(['skill', 'install', '--json']);
    assert.equal(r.code, 0, text(r));
    assertIdenticalToBundled(dest(e.home, 'claude'));
    assert.ok(!exists(dest(e.home, 'codex')));
    assert.ok(!exists(dest(e.home, 'cursor')));
    assert.deepEqual(r.json.installed.map((x) => x.agent), ['claude']);
  });

  for (const folder of ['.codex', '.agents', '.cursor']) {
    test(`only ~/${folder} exists: the shared codex target only, never ~/.cursor/skills`, async (t) => {
      const e = createEnvironment(t);
      mk(e.home, folder);
      const r = await e.run(['skill', 'install', '--json']);
      assert.equal(r.code, 0, text(r));
      assertIdenticalToBundled(dest(e.home, 'codex'));
      assert.ok(!exists(dest(e.home, 'claude')));
      assert.ok(!exists(e.home, '.cursor', 'skills'), 'cursor target is only used when asked for');
      assert.deepEqual(r.json.installed.map((x) => x.agent), ['codex']);
    });
  }

  test('~/.claude and ~/.codex both exist: both', async (t) => {
    const e = createEnvironment(t);
    mk(e.home, '.claude');
    mk(e.home, '.codex');
    const r = await e.run(['skill', 'install', '--json']);
    assert.equal(r.code, 0, text(r));
    assertIdenticalToBundled(dest(e.home, 'claude'));
    assertIdenticalToBundled(dest(e.home, 'codex'));
    assert.ok(!exists(dest(e.home, 'cursor')));
  });

  test('nothing found: exit 2, nothing written, the message lists the --agent choices', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install']);
    assert.equal(r.code, 2, text(r));
    const out = text(r);
    assert.ok(out.includes('--agent'), out);
    for (const a of ['claude', 'codex', 'cursor']) assert.ok(out.includes(a), `message should name ${a}`);
    assert.deepEqual(snapshot(e.home), []);
    assert.deepEqual(snapshot(e.cwd), []);
    assert.equal(e.calls.length, 0);
  });

  test('the nothing-found error is a usage error in --json', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install', '--json']);
    assert.equal(r.code, 2);
    assert.equal(r.error?.code, 'usage');
  });
});

describe('re-installing', () => {
  test('replaces the old copy: stale files go, edited files are restored, replaced is reported', async (t) => {
    const e = createEnvironment(t);
    const first = await e.run(['skill', 'install', '--agent', 'codex', '--json']);
    assert.equal(first.json.installed[0].replaced, false);

    const target = dest(e.home, 'codex');
    fs.writeFileSync(path.join(target, 'stale-extra.txt'), 'left over');
    const original = fs.readFileSync(path.join(BUNDLED, 'SKILL.md'), 'utf8');
    fs.writeFileSync(path.join(target, 'SKILL.md'), original + '\nlocal edit\n');

    const again = await e.run(['skill', 'install', '--agent', 'codex', '--json']);
    assert.equal(again.code, 0, text(again));
    assert.equal(again.json.installed[0].replaced, true);
    assert.ok(!exists(target, 'stale-extra.txt'), 'stale file removed');
    assertIdenticalToBundled(target);
  });

  test('human output says replaced', async (t) => {
    const e = createEnvironment(t);
    await e.run(['skill', 'install', '--agent', 'claude']);
    const r = await e.run(['skill', 'install', '--agent', 'claude']);
    assert.equal(r.code, 0, text(r));
    assert.match(r.stdout, /replaced/i);
  });

  test('replaced is reported per agent when only one was installed before', async (t) => {
    const e = createEnvironment(t);
    await e.run(['skill', 'install', '--agent', 'claude']);
    const r = await e.run(['skill', 'install', '--agent', 'claude,codex', '--json']);
    assert.equal(r.code, 0, text(r));
    assert.equal(entryFor(r.json.installed, 'claude').replaced, true);
    assert.equal(entryFor(r.json.installed, 'codex').replaced, false);
  });
});

describe('safety', () => {
  test('other skills in the same parent folder are untouched by install and uninstall', async (t) => {
    const e = createEnvironment(t);
    const other = path.join(e.home, '.agents', 'skills', 'other');
    mk(other);
    fs.writeFileSync(path.join(other, 'SKILL.md'), '---\nname: other\ndescription: x\n---\nhello\n');
    const before = fs.readFileSync(path.join(other, 'SKILL.md'));

    assert.equal((await e.run(['skill', 'install', '--agent', 'codex'])).code, 0);
    assert.ok(fs.readFileSync(path.join(other, 'SKILL.md')).equals(before));
    assert.equal((await e.run(['skill', 'install', '--agent', 'codex'])).code, 0);
    assert.ok(fs.readFileSync(path.join(other, 'SKILL.md')).equals(before));
    assert.equal((await e.run(['skill', 'uninstall', '--agent', 'codex'])).code, 0);
    assert.ok(fs.readFileSync(path.join(other, 'SKILL.md')).equals(before));
    assert.ok(!exists(dest(e.home, 'codex')));
  });

  test('a cheapgen folder with no SKILL.md is not overwritten (exit 2)', async (t) => {
    const e = createEnvironment(t);
    const target = dest(e.home, 'codex');
    mk(target);
    fs.writeFileSync(path.join(target, 'notes.txt'), 'mine');
    const r = await e.run(['skill', 'install', '--agent', 'codex']);
    assert.equal(r.code, 2, text(r));
    assert.deepEqual(snapshot(target), ['notes.txt']);
    assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'mine');
  });

  test('a cheapgen folder whose SKILL.md has another name is not overwritten (exit 2)', async (t) => {
    const e = createEnvironment(t);
    const target = dest(e.home, 'claude');
    mk(target);
    const content = '---\nname: something-else\ndescription: not ours\n---\nbody\n';
    fs.writeFileSync(path.join(target, 'SKILL.md'), content);
    const r = await e.run(['skill', 'install', '--agent', 'claude', '--json']);
    assert.equal(r.code, 2, text(r));
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), content);
    assert.deepEqual(snapshot(target), ['SKILL.md']);
  });

  test('a refusal for one agent writes nothing for the others in the same command', async (t) => {
    const e = createEnvironment(t);
    mk(dest(e.home, 'codex'));
    const r = await e.run(['skill', 'install', '--agent', 'claude,codex']);
    assert.equal(r.code, 2, text(r));
    assert.deepEqual(snapshot(dest(e.home, 'codex')), []);
    assert.ok(!exists(dest(e.home, 'claude')), 'no partial install');
  });

  test('a symbolic link at the target is neither followed nor replaced (exit 2)', async (t) => {
    const e = createEnvironment(t);
    const real = path.join(e.cwd, 'real-folder');
    mk(real);
    fs.writeFileSync(path.join(real, 'SKILL.md'), '---\nname: cheapgen\ndescription: elsewhere\n---\nold\n');
    const link = dest(e.home, 'codex');
    mk(path.dirname(link));
    try {
      fs.symlinkSync(real, link, 'junction');
    } catch (err) {
      t.skip(`cannot create a link here: ${err.code}`);
      return;
    }
    const r = await e.run(['skill', 'install', '--agent', 'codex']);
    assert.equal(r.code, 2, text(r));
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'link still in place');
    assert.deepEqual(snapshot(real), ['SKILL.md']);
    assert.match(fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8'), /elsewhere/);

    const u = await e.run(['skill', 'uninstall', '--agent', 'codex']);
    assert.equal(u.code, 2, text(u));
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'uninstall leaves the link');
    assert.deepEqual(snapshot(real), ['SKILL.md']);
  });
});

describe('skill uninstall', () => {
  test('removes the installed folder and reports it', async (t) => {
    const e = createEnvironment(t);
    await e.run(['skill', 'install', '--agent', 'codex,claude']);
    const r = await e.run(['skill', 'uninstall', '--agent', 'codex', '--json']);
    assert.equal(r.code, 0, text(r));
    assert.ok(!exists(dest(e.home, 'codex')));
    assert.ok(exists(dest(e.home, 'claude')), 'other agents keep their copy');
    assert.equal(r.json.removed.length, 1);
    assert.equal(r.json.removed[0].agent, 'codex');
    assert.equal(normPath(r.json.removed[0].path), normPath(dest(e.home, 'codex')));
  });

  test('--project removes from the current folder only', async (t) => {
    const e = createEnvironment(t);
    await e.run(['skill', 'install', '--agent', 'claude']);
    await e.run(['skill', 'install', '--project', '--agent', 'claude']);
    const r = await e.run(['skill', 'uninstall', '--project', '--agent', 'claude', '--json']);
    assert.equal(r.code, 0, text(r));
    assert.ok(!exists(dest(e.cwd, 'claude')));
    assert.ok(exists(dest(e.home, 'claude')));
  });

  test('a missing skill is not an error and removes nothing', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'uninstall', '--agent', 'codex', '--json']);
    assert.equal(r.code, 0, text(r));
    assert.deepEqual(r.json.removed ?? [], []);
    assert.deepEqual(snapshot(e.home), []);
  });

  test('refuses to remove a cheapgen folder that is not a cheapgen skill (exit 2)', async (t) => {
    const e = createEnvironment(t);
    const target = dest(e.home, 'codex');
    mk(target);
    fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: not-cheapgen\ndescription: x\n---\n');
    fs.writeFileSync(path.join(target, 'data.txt'), 'keep me');
    const r = await e.run(['skill', 'uninstall', '--agent', 'codex']);
    assert.equal(r.code, 2, text(r));
    assert.deepEqual(snapshot(target), ['SKILL.md', 'data.txt']);

    const noSkillMd = dest(e.home, 'claude');
    mk(noSkillMd);
    fs.writeFileSync(path.join(noSkillMd, 'data.txt'), 'keep me');
    const r2 = await e.run(['skill', 'uninstall', '--agent', 'claude']);
    assert.equal(r2.code, 2, text(r2));
    assert.deepEqual(snapshot(noSkillMd), ['data.txt']);
  });

  test('without --agent it removes from the locations that detection finds', async (t) => {
    const e = createEnvironment(t);
    mk(e.home, '.claude');
    mk(e.home, '.codex');
    await e.run(['skill', 'install']);
    assert.ok(exists(dest(e.home, 'claude')) && exists(dest(e.home, 'codex')));
    const r = await e.run(['skill', 'uninstall', '--json']);
    assert.equal(r.code, 0, text(r));
    assert.ok(!exists(dest(e.home, 'claude')));
    assert.ok(!exists(dest(e.home, 'codex')));
    assert.deepEqual(r.json.removed.map((x) => x.agent).sort(), ['claude', 'codex']);
  });

  test('without --agent and nothing found it exits 2 like install', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'uninstall']);
    assert.equal(r.code, 2, text(r));
    assert.ok(text(r).includes('--agent'));
  });
});

describe('skill path', () => {
  test('prints the absolute bundled folder, which holds SKILL.md', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'path']);
    assert.equal(r.code, 0, text(r));
    const printed = r.stdout.trim();
    assert.ok(path.isAbsolute(printed), printed);
    assert.equal(normPath(printed), normPath(BUNDLED));
    assert.ok(exists(printed, 'SKILL.md'));
    assert.equal(e.calls.length, 0);
  });

  test('--json gives { path }', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'path', '--json']);
    assert.equal(r.code, 0, text(r));
    assert.equal(normPath(r.json.path), normPath(BUNDLED));
    assert.ok(exists(r.json.path, 'SKILL.md'));
  });

  test('does not write anything', async (t) => {
    const e = createEnvironment(t);
    await e.run(['skill', 'path']);
    assert.deepEqual(snapshot(e.home), []);
    assert.deepEqual(snapshot(e.cwd), []);
  });
});

describe('usage errors', () => {
  test('an unknown agent is a usage error naming the valid choices, and writes nothing', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install', '--agent', 'vscode', '--json']);
    assert.equal(r.code, 2, text(r));
    assert.equal(r.error?.code, 'usage');
    for (const a of ['claude', 'codex', 'cursor']) assert.ok(r.error.message.includes(a), `message should name ${a}`);
    assert.deepEqual(snapshot(e.home), []);
  });

  test('one bad name in a list rejects the whole command', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'install', '--agent', 'claude,vscode']);
    assert.equal(r.code, 2, text(r));
    assert.ok(!exists(dest(e.home, 'claude')), 'nothing installed');
  });

  test('uninstall also rejects an unknown agent', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'uninstall', '--agent', 'vscode']);
    assert.equal(r.code, 2, text(r));
  });

  test('an unknown subcommand is exit 2', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill', 'foo']);
    assert.equal(r.code, 2, text(r));
    assert.ok(/install|uninstall|path/.test(text(r)), 'usage should name the subcommands');
  });

  test('bare `skill` is exit 2', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['skill']);
    assert.equal(r.code, 2, text(r));
  });
});

describe('help and isolation', () => {
  test('--help mentions the skill command', async (t) => {
    const e = createEnvironment(t);
    const r = await e.run(['--help']);
    assert.equal(r.code, 0, text(r));
    assert.match(r.stdout, /\bskill\b/);
  });

  test('install needs no keys and makes no network calls', async (t) => {
    const e = createEnvironment(t, { env: {} });
    const r = await e.run(['skill', 'install', '--agent', 'claude,codex,cursor']);
    assert.equal(r.code, 0, text(r));
    assert.equal(e.calls.length, 0);
  });
});
