// `cheapgen config list | show | path | set <key> <value> | set-key <provider> | get-key <provider>`.
import { EXIT, usageError } from '../../errors.js';
import { PROVIDER_IDS, ENV_VARS, storeKey, storeSetting } from '../../config.js';
import { ADAPTERS } from '../../providers/index.js';
import { notConnectedError } from '../../router.js';
import { table } from '../output.js';

const USAGE = 'cheapgen config list | show | path | set <key> <value> | set-key <provider> | get-key <provider>';
const MIN_LENGTH_TO_SHOW_END = 12;

/** Enough of a key to tell two apart, never the key itself. */
const mask = (key) => (key.length < MIN_LENGTH_TO_SHOW_END ? '****' : `****${key.slice(-4)}`);

function keyInfo(app, id) {
  const key = app.keys[id];
  return { provider: id, envVar: ENV_VARS[id], set: Boolean(key), source: app.keySources[id], masked: key ? mask(key) : null };
}

const sourceText = (info) => (info.source === 'env' ? info.envVar : 'config file');

function checkProvider(id) {
  if (!PROVIDER_IDS.includes(id)) throw usageError(`unknown provider "${id}". Providers: ${PROVIDER_IDS.join(', ')}`);
}

export async function config(app) {
  const [sub, ...rest] = app.args;
  switch (sub ?? 'show') {
    case 'list': return list(app, rest);
    case 'show': return show(app, rest);
    case 'path': return showPath(app, rest);
    case 'set': return set(app, rest);
    case 'set-key': return setKey(app, rest);
    case 'get-key': return getKey(app, rest);
    default: throw usageError(`unknown config command "${sub}". Usage: ${USAGE}`);
  }
}

function list(app, rest) {
  if (rest.length) throw usageError(`too many arguments. Usage: ${USAGE}`);
  const keys = PROVIDER_IDS.map((id) => keyInfo(app, id));
  const keyRows = keys.map((k) => [`  ${k.provider}`, ...(k.set ? [k.masked, `from ${sourceText(k)}`] : ['not set'])]);
  const settingRows = Object.entries(app.config).map(([k, v]) => [`  ${k}`, typeof v === 'string' ? v : JSON.stringify(v)]);
  const text = ['API keys', table(keyRows), '', 'Settings', table(settingRows), '', 'Files',
    table([['  user', app.configFiles.user], ['  project', app.configFiles.project]])].join('\n');
  app.out.result({ keys, settings: app.config, files: app.configFiles }, text);
  return EXIT.OK;
}

function getKey(app, rest) {
  if (rest.length !== 1) throw usageError('usage: cheapgen config get-key <provider>, for example: cheapgen config get-key kie');
  const id = rest[0];
  checkProvider(id);
  const info = keyInfo(app, id);
  if (!info.set) throw notConnectedError(id);
  app.out.result(info, `${id}  ${info.masked}  from ${sourceText(info)}`);
  return EXIT.OK;
}

function show(app, rest) {
  if (rest.length) throw usageError(`too many arguments. Usage: ${USAGE}`);
  const keys = Object.fromEntries(PROVIDER_IDS.map((id) => [id,
    app.keySources[id] === 'env' ? `set (${ENV_VARS[id]})` : app.keySources[id] === 'file' ? 'set (config file)' : 'not set']));
  const obj = { files: app.configFiles, settings: app.config, keys };
  app.out.result(obj, JSON.stringify(obj, null, 2));
  return EXIT.OK;
}

function showPath(app, rest) {
  if (rest.length) throw usageError(`too many arguments. Usage: ${USAGE}`);
  app.out.result({ files: app.configFiles }, `user:    ${app.configFiles.user}\nproject: ${app.configFiles.project}`);
  return EXIT.OK;
}

function set(app, rest) {
  if (rest.length !== 2) throw usageError('usage: cheapgen config set <key> <value>, for example: config set maxCostPerRun 0.5');
  const [key, raw] = rest;
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  const { file } = storeSetting(app.io, key, value);
  app.out.result({ set: key, value, file }, `Set ${key} = ${JSON.stringify(value)} in ${file}`);
  return EXIT.OK;
}

async function setKey(app, rest) {
  // Never accept the key as an argument: it would end up in shell history. The
  // message deliberately doesn't repeat the arguments.
  if (rest.length !== 1) {
    throw usageError('usage: cheapgen config set-key <provider>, for example: cheapgen config set-key kie. '
      + 'It asks for the key. Keys are never accepted as arguments.');
  }
  const id = rest[0];
  checkProvider(id);
  const answer = app.io.promptSecret
    ? await app.io.promptSecret(`${ADAPTERS[id].displayName} API key (hidden): `)
    : await app.io.readStdin();
  if (answer === null) throw usageError('cancelled, nothing was stored');
  const input = String(answer ?? '');
  const key = input.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
  if (!key) {
    throw usageError(app.io.promptSecret ? 'no key entered, nothing was stored'
      : `no key on standard input. Run \`cheapgen config set-key ${id}\` in a terminal, or pipe the key in.`);
  }
  app.secrets.push(key);
  const { file, warnings } = storeKey(app.io, id, key);
  for (const w of warnings) app.out.warn(w);
  if (app.keySources[id] === 'env') app.out.warn(`${ENV_VARS[id]} is set in your environment and takes precedence over the stored key`);
  app.out.result({ stored: true, provider: id, file }, `Stored the ${id} key in ${file}.`);
  return EXIT.OK;
}
