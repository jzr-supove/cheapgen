// CLI entry point. `main(argv, io)` returns the exit code and never calls process.exit, so the
// whole CLI runs in-process in tests with everything injected.
import { parseArgs } from 'node:util';
import { CliError, EXIT, usageError } from '../errors.js';
import { loadCatalog, DEFAULT_DATA_DIR } from '../catalog.js';
import { loadConfig } from '../config.js';
import { createPriceCache } from '../pricing/cache.js';
import { redact } from '../http.js';
import { createOutput } from './output.js';
import { readSecret } from './prompt.js';
import { COMMANDS, HELP } from './commands/index.js';

const OPTIONS = {
  prompt: { type: 'string' },
  image: { type: 'string' },
  res: { type: 'string' },
  size: { type: 'string' },
  duration: { type: 'string' },
  aspect: { type: 'string' },
  audio: { type: 'boolean' },
  'no-audio': { type: 'boolean' },
  provider: { type: 'string' },
  exclude: { type: 'string', multiple: true },
  'max-cost': { type: 'string' },
  'dry-run': { type: 'boolean' },
  wait: { type: 'boolean' },
  download: { type: 'string' },
  'no-download': { type: 'boolean' },
  timeout: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'allow-auto-duration': { type: 'boolean' },
  json: { type: 'boolean' },
  search: { type: 'string' },
  since: { type: 'string' },
  check: { type: 'boolean' },
  agent: { type: 'string', multiple: true },
  project: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

/**
 * @param {string[]} argv  arguments after the program name
 * @param {object} [io]    { env, fetch, stdout, stderr, stdin, promptSecret, homedir, cwd, now, sleep,
 *                         dataDir, platform }
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  io = await withDefaults(io);
  // Every byte written to the terminal goes through redaction. Keys are added once loaded.
  const secrets = [];
  const scrub = (s) => redact(s, secrets);
  const stdout = { write: (s) => io.stdout.write(scrub(s)) };
  const stderr = { write: (s) => io.stderr.write(scrub(s)) };

  let json = argv.includes('--json');
  const out = createOutput({ stdout, stderr, json });
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
      throw usageError(String(err.message).replace(/^TypeError \[[A-Z_]+\]: /, '').split('\n')[0]);
    }
    const { values: flags, positionals } = parsed;
    json = Boolean(flags.json);
    out.setJson(json);

    const [name, ...args] = positionals;
    if (flags.version) { out.text(`${await version()}\n`); return EXIT.OK; }
    if (!name || flags.help || name === 'help') { out.text(HELP); return name || flags.help ? EXIT.OK : EXIT.USAGE; }
    const command = COMMANDS[name];
    if (!command) throw usageError(`unknown command "${name}". Run \`cheapgen --help\` for the list.`);

    const loaded = loadConfig(io);
    secrets.push(...Object.values(loaded.keys));
    for (const w of loaded.warnings) out.warn(w);

    const app = {
      io, out, flags, args, secrets,
      config: loaded.config, keys: loaded.keys, keySources: loaded.keySources, configFiles: loaded.files,
      get catalog() { return (this._catalog ??= loadCatalog(io.dataDir)); },
      priceCache: createPriceCache(io.homedir),
      priceMemo: new Map(),
      liveMemo: new Map(),
      balanceMemo: new Map(),
      redact: scrub,
    };
    return (await command(app)) ?? EXIT.OK;
  } catch (err) {
    if (err instanceof CliError) {
      out.error(err);
      return err.exitCode;
    }
    out.error(new CliError(EXIT.BUG, 'bug', `unexpected error: ${err?.stack ?? err}`));
    return EXIT.BUG;
  }
}

async function withDefaults(io) {
  const os = await import('node:os');
  return {
    env: io.env ?? process.env,
    fetch: io.fetch ?? globalThis.fetch,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    stdin: io.stdin,
    readStdin: io.readStdin ?? (io.stdin === undefined ? readProcessStdin : async () => io.stdin),
    // Only set when a person is at the terminal. The prompt goes to stderr, so stdout stays clean.
    promptSecret: io.promptSecret ?? (io.stdin === undefined && process.stdin.isTTY
      ? (label) => readSecret({ input: process.stdin, output: process.stderr, label }) : null),
    homedir: io.homedir ?? os.homedir(),
    cwd: io.cwd ?? process.cwd(),
    now: io.now ?? (() => new Date()),
    sleep: io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    dataDir: io.dataDir ?? DEFAULT_DATA_DIR,
    platform: io.platform ?? process.platform,
    mcpInput: io.mcpInput,
  };
}

async function readProcessStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function version() {
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}
