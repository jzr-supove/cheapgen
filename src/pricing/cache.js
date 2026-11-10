// On-disk cache of live prices, valid for 24 hours. Holds prices only, never keys.
import fs from 'node:fs';
import path from 'node:path';

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function createPriceCache(homedir) {
  const file = path.join(homedir, '.cheapgen', 'cache', 'live-prices.json');
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    return data;
  };
  return {
    /** @returns {{ usd: number, at: string } | null} */
    get(key, now) {
      const hit = load()[key];
      if (!hit || typeof hit.usd !== 'number') return null;
      const age = now.getTime() - Date.parse(hit.at);
      return age >= 0 && age < CACHE_TTL_MS ? hit : null;
    },
    set(key, usd, now) {
      const d = load();
      d[key] = { usd, at: now.toISOString() };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(d));
      } catch { /* a cache that can't be written is just a slower cache */ }
    },
  };
}
