// Loads the data files: models, prices and frame sizes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT } from './errors.js';

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(EXIT.BUG, 'data', `can't read ${path.basename(file)} (${err.code ?? err.message}). `
      + 'The installation may be incomplete.');
  }
}

/**
 * @param {string} [dataDir]
 * @returns {{ models: object, prices: { schemaVersion: number, entries: object[] }, frameSizes: object }}
 */
export function loadCatalog(dataDir = DEFAULT_DATA_DIR) {
  const models = readJson(path.join(dataDir, 'models.json'));
  const prices = readJson(path.join(dataDir, 'prices.json'));
  const frameSizes = readJson(path.join(dataDir, 'frame-sizes.json'));
  if (prices.schemaVersion !== 1) {
    throw new CliError(EXIT.BUG, 'data', `prices.json schemaVersion ${prices.schemaVersion} is not supported`);
  }
  return { models, prices, frameSizes };
}
