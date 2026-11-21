# Test fixtures

- `data/`: small fixture catalog (models, prices, frame sizes) with made-up but realistic prices.
  Tests pass this directory as `io.dataDir`, so they don't break when the real `data/` changes.
- `kie/`, `replicate/`, `wavespeed/`, `fal/`: provider responses. Files with a `_recorded` field
  are real responses, with ids, URLs, balances and account details replaced where the field says
  so. Files with a `_synthetic` field were built from each provider's docs; replace them with recorded responses.
  Every URL and field assumption lives in `test/helpers/providers.js` (routes) and these files.
- `data-live/`: tiny catalog for the Kie live-price and `prices --check` tests: Kie entries with
  `live.kieDescription`, one entry each for the other providers, one stale entry. Don't change
  the numbers without updating `test/kie-live-price.test.js` and `test/prices-check.test.js`.
- `kie/price-list-page.json`: one page of Kie's public price list, cut to a single row.
