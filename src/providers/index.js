// The provider registry and the catalog-based "does this provider offer the request" check.
import kie from './kie.js';
import replicate from './replicate.js';
import wavespeed from './wavespeed.js';
import fal from './fal.js';

export const ADAPTERS = Object.freeze({ kie, replicate, wavespeed, fal });

/**
 * Does `providerId` offer this request, according to data/models.json? A provider-level
 * `modes`, `resolutions`, `durations`, `sizes` or `aspectRatios` entry narrows the model's options.
 * @returns {{ ok: true, entry: object } | { ok: false, reason: string }}
 */
export function supports(catalog, providerId, r) {
  const entry = catalog.models[r.model]?.providers?.[providerId];
  const no = (reason) => ({ ok: false, reason: `${providerId} ${reason}` });
  if (!entry) return no(`doesn't offer ${r.model}`);
  if (entry.modes && typeof entry.modes[r.mode] !== 'string') return no(`doesn't offer ${r.model} as ${r.mode}`);
  if (r.resolution && entry.resolutions && !entry.resolutions.includes(r.resolution)) {
    return no(`doesn't offer ${r.model} at ${r.resolution}`);
  }
  if (r.size && entry.sizes && !entry.sizes.includes(r.size)) return no(`doesn't offer ${r.model} at size ${r.size}`);
  if (entry.aspectRatios && !entry.aspectRatios.includes(r.aspectRatio)) {
    return no(`doesn't offer ${r.model} at ${r.aspectRatio}`);
  }
  if (entry.durations && !r.autoDuration && (r.duration < entry.durations.min || r.duration > entry.durations.max)) {
    return no(`offers ${r.model} only from ${entry.durations.min} to ${entry.durations.max} seconds`);
  }
  return { ok: true, entry };
}
