# Test fixtures

- `data/`: small fixture catalog (models, prices, frame sizes) with made-up but realistic prices.
  Tests pass this directory as `io.dataDir`, so they don't break when the real `data/` changes.
- `kie/`, `replicate/`, `wavespeed/`, `fal/`: provider responses. **Synthetic**: built from the
  shapes in each provider's docs because no recorded real responses exist yet
  (no keys). Each file carries a `_synthetic` field. Replace them with recorded responses later.
  Every URL and field assumption lives in `test/helpers/providers.js` (routes) and these files.
