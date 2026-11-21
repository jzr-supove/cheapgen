# Test fixtures

- `data/`: small fixture catalog (models, prices, frame sizes) with made-up but realistic prices.
  Tests pass this directory as `io.dataDir`, so they don't break when the real `data/` changes.
- `kie/`, `replicate/`, `wavespeed/`, `fal/`: provider responses. **Synthetic**: built from the
  shapes in each provider's docs because no recorded real responses exist yet
  (no keys). Each file carries a `_synthetic` field. Replace them with recorded responses later.
  Every URL and field assumption lives in `test/helpers/providers.js` (routes) and these files.
- `data-live/`: tiny catalog for the Kie live-price and `prices --check` tests: Kie entries with
  `live.kieDescription`, one entry each for the other providers, one stale entry. Don't change
  the numbers without updating `test/kie-live-price.test.js` and `test/prices-check.test.js`.
- `kie/price-list-page.json`: shape of one page of Kie's public price list (rows are in
  `data.records`, a guess from the shape `data.current`/`data.pages`; confirm when recorded).
  `fal/status-completed-error.json`, `fal/result-422.json`, `fal/upload-initiate.json`,
  `wavespeed/result-{cancelled,timeout,deleted}.json`, `wavespeed/price-live-discounted.json`,
  `replicate/file-upload.json`: also synthetic, for the provider-detail tests.
