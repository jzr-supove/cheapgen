// `cheapgen config show | path | set <key> <value> | set-key <provider>`.
import { EXIT, usageError } from '../../errors.js';
import { PROVIDER_IDS, ENV_VARS, storeKey, storeSetting } from '../../config.js';

const USAGE = 'cheapgen config show | path | set <key> <value> | set-key <provider>';

export async function config(app) {
  const [sub, ...rest] = app.args;
  switch (sub ?? 'show') {
    case 'show': return show(app, rest);
    case 'path': return showPath(app, rest);
    case 'set': return set(app, rest);
    case 'set-key': return setKey(app, rest);
    default: throw usageError(`unknown config command "${sub}". Usage: ${USAGE}`);
  }
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
    throw usageError('usage: cheapgen config set-key <provider>, with the key on standard input, '
      + 'for example: echo "$KEY" | cheapgen config set-key kie. Keys are never accepted as arguments.');
  }
  const id = rest[0];
  if (!PROVIDER_IDS.includes(id)) throw usageError(`unknown provider "${id}". Providers: ${PROVIDER_IDS.join(', ')}`);
  const input = String((await app.io.readStdin()) ?? '');
  const key = input.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
  if (!key) throw usageError(`no key on standard input. Pipe it in, for example: echo "$KEY" | cheapgen config set-key ${id}`);
  app.secrets.push(key);
  const { file, warnings } = storeKey(app.io, id, key);
  for (const w of warnings) app.out.warn(w);
  if (app.keySources[id] === 'env') app.out.warn(`${ENV_VARS[id]} is set in your environment and takes precedence over the stored key`);
  app.out.result({ stored: true, provider: id, file }, `Stored the ${id} key in ${file}.`);
  return EXIT.OK;
}
