// Config loading. Layers, lowest to highest: built-in defaults, user file,
// project file, environment keys. Command-line flags are applied by the commands.
// Merging is per key: objects merge field by field, arrays replace.
import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usageError } from './errors.js';

export const PROVIDER_IDS = ['kie', 'replicate', 'wavespeed', 'fal'];
export const ENV_VARS = { kie: 'KIE_API_KEY', replicate: 'REPLICATE_API_TOKEN', wavespeed: 'WAVESPEED_API_KEY', fal: 'FAL_KEY' };

export const DEFAULTS = Object.freeze({
  providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { enabled: true }])),
  strategy: 'cheapest',
  prefer: [],
  maxCostPerRun: 1.0,
  allowVariants: false,
  retryFailedJobs: false,
  showUnconnected: true,
  models: {},
});

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));
const KNOWN_PROVIDER_KEYS = new Set(['enabled', 'key']);

export function userConfigPath({ env, homedir, cwd }) {
  if (env.CHEAPGEN_CONFIG) return path.resolve(cwd, env.CHEAPGEN_CONFIG);
  return path.join(homedir, '.cheapgen', 'config.json');
}

export const projectConfigPath = ({ cwd }) => path.join(cwd, '.cheapgen.json');

function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CliError(EXIT.USAGE, 'config', `can't read config file ${file}: ${err.code ?? err.message}`);
  }
  try {
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    return obj;
  } catch {
    throw new CliError(EXIT.USAGE, 'config', `config file ${file} is not valid JSON`);
  }
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}

function check(layer, file, warnings) {
  for (const key of Object.keys(layer)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown config key "${key}" in ${file} (ignored)`);
  }
  if (layer.providers !== undefined) {
    if (!isPlainObject(layer.providers)) throw usageError(`"providers" in ${file} must be an object`);
    for (const [id, p] of Object.entries(layer.providers)) {
      if (!PROVIDER_IDS.includes(id)) { warnings.push(`unknown provider "${id}" in ${file} (ignored)`); continue; }
      if (!isPlainObject(p)) throw usageError(`"providers.${id}" in ${file} must be an object`);
      for (const k of Object.keys(p)) {
        if (!KNOWN_PROVIDER_KEYS.has(k)) warnings.push(`unknown config key "providers.${id}.${k}" in ${file} (ignored)`);
      }
    }
  }
  if (layer.strategy !== undefined && !['cheapest', 'preferred'].includes(layer.strategy)) {
    throw usageError(`"strategy" in ${file} must be "cheapest" or "preferred"`);
  }
  if (layer.prefer !== undefined && !(Array.isArray(layer.prefer) && layer.prefer.every((p) => typeof p === 'string'))) {
    throw usageError(`"prefer" in ${file} must be a list of provider ids`);
  }
  if (layer.maxCostPerRun !== undefined && !(typeof layer.maxCostPerRun === 'number' && layer.maxCostPerRun >= 0)) {
    throw usageError(`"maxCostPerRun" in ${file} must be a number of US dollars`);
  }
  for (const k of ['allowVariants', 'retryFailedJobs', 'showUnconnected']) {
    if (layer[k] !== undefined && typeof layer[k] !== 'boolean') throw usageError(`"${k}" in ${file} must be true or false`);
  }
  if (layer.models !== undefined && !isPlainObject(layer.models)) throw usageError(`"models" in ${file} must be an object`);
}

/** Takes `key` fields out of a layer, returning [layerWithoutKeys, keys]. */
function splitKeys(layer) {
  const keys = {};
  if (!isPlainObject(layer.providers)) return [layer, keys];
  const providers = {};
  for (const [id, p] of Object.entries(layer.providers)) {
    if (!isPlainObject(p)) { providers[id] = p; continue; }
    const { key, ...rest } = p;
    if (typeof key === 'string' && key.trim() && PROVIDER_IDS.includes(id)) keys[id] = key.trim();
    providers[id] = rest;
  }
  return [{ ...layer, providers }, keys];
}

/**
 * @returns {{ config: object, keys: Record<string, string>, keySources: Record<string, 'env'|'file'|null>,
 *             warnings: string[], files: { user: string, project: string } }}
 */
export function loadConfig(io) {
  const warnings = [];
  const files = { user: userConfigPath(io), project: projectConfigPath(io) };
  let config = DEFAULTS;
  const fileKeys = {};
  for (const file of [files.user, files.project]) {
    const raw = readConfigFile(file);
    if (!raw) continue;
    check(raw, file, warnings);
    const [layer, keys] = splitKeys(raw);
    const known = Object.fromEntries(Object.entries(layer).filter(([k]) => KNOWN_KEYS.has(k)));
    known.providers &&= Object.fromEntries(Object.entries(known.providers).filter(([id]) => PROVIDER_IDS.includes(id)));
    config = merge(config, known);
    Object.assign(fileKeys, keys);
  }

  const keys = {};
  const keySources = {};
  for (const id of PROVIDER_IDS) {
    const fromEnv = io.env[ENV_VARS[id]];
    if (typeof fromEnv === 'string' && fromEnv.trim()) { keys[id] = fromEnv.trim(); keySources[id] = 'env'; }
    else if (fileKeys[id]) { keys[id] = fileKeys[id]; keySources[id] = 'file'; }
    else keySources[id] = null;
  }

  // Keys live outside the config object, so printing the config can't include them.
  return { config: deepFreeze(structuredClone(config)), keys: Object.freeze(keys), keySources, warnings, files };
}

/**
 * Stores a key in the user config file. Returns warnings to show.
 * @returns {{ file: string, warnings: string[] }}
 */
export function storeKey(io, providerId, key) {
  const file = userConfigPath(io);
  const raw = readConfigFile(file) ?? {};
  raw.providers = isPlainObject(raw.providers) ? raw.providers : {};
  raw.providers[providerId] = { ...(isPlainObject(raw.providers[providerId]) ? raw.providers[providerId] : {}), key };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  const warnings = [];
  if ((io.platform ?? process.platform) === 'win32') {
    warnings.push(`can't restrict who can read ${file} on Windows. `
      + `Consider setting ${ENV_VARS[providerId]} in your environment instead.`);
  } else {
    try { fs.chmodSync(file, 0o600); } catch { warnings.push(`couldn't restrict permissions on ${file}`); }
  }
  return { file, warnings };
}

/** Sets one non-secret setting in the user config file. */
export function storeSetting(io, dottedKey, value) {
  const file = userConfigPath(io);
  const raw = readConfigFile(file) ?? {};
  const parts = dottedKey.split('.');
  if (!KNOWN_KEYS.has(parts[0])) throw usageError(`unknown setting "${parts[0]}"`);
  if (parts.at(-1) === 'key') throw usageError('use `cheapgen config set-key <provider>` to store a key');
  let node = raw;
  for (const p of parts.slice(0, -1)) {
    node[p] = isPlainObject(node[p]) ? node[p] : {};
    node = node[p];
  }
  node[parts.at(-1)] = value;
  check(raw, file, []);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return { file };
}
