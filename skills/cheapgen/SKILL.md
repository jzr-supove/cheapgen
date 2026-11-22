---
name: cheapgen
description: Generate AI videos (Seedance 2.0 / 2.5) and images (Seedream 5, Nano Banana, FLUX 2 Pro) through the cheapest provider the user has a key for (Kie, Replicate, WaveSpeed, fal), using the cheapgen CLI. Use when the user asks to make, generate or price a video or image with one of these models, or asks what a generation would cost.
---

# cheapgen

`cheapgen` is a CLI that prices a request on every provider and sends it to the cheapest
connected one. Every real run spends the user's money, so follow these rules exactly.

## Rules

1. **Quote before every run.** Run `cheapgen quote <model> [params] --json` and tell the user
   the provider `run` would use (`chosen`), its price (`usd`) and where the price came from
   (`source`: live, cache or bundled, with `verifiedOn`). Mention any `warnings`.
2. **Get a yes before spending.** Start a run only after the user agrees to that price. Ask
   again if the request changes. If a price is unknown (`usd: null`) or above the cost limit,
   say so and offer a cheaper option: a cheaper model (`seedance-2.0-mini` or
   `seedance-2.0-fast` for video), 480p, or a shorter duration.
3. **Never pass `--yes` or raise `--max-cost` on your own.** Use them only when the user has
   agreed to that specific price for that specific run.
4. **Exit code 5 means the job may exist and may be billed.** Never resubmit, and never try
   another provider. Tell the user to check that provider's dashboard and let them decide.
5. **Keys are the user's.** Never ask for a key in the chat, and never put one in a command.
   If no provider is connected (exit 3, `no_keys`), tell the user to set `KIE_API_KEY`,
   `REPLICATE_API_TOKEN`, `WAVESPEED_API_KEY` or `FAL_KEY`, or to run
   `cheapgen config set-key <provider>` themselves in a terminal (it asks for
   the key and hides it).
6. **Don't change the user's config** (`cheapgen config set ...`) unless they ask.

## Models

Video: `seedance-2.0-mini` (cheapest), `seedance-2.0-fast`, `seedance-2.0`,
`seedance-2.5-flash`, `seedance-2.5`. Image: `seedream-5.5`, `seedream-5-pro`,
`seedream-5-lite`, `nano-banana-2.1`, `nano-banana-pro`, `flux-2-pro`.
`cheapgen models` lists them with their resolutions or sizes and providers.

## Parameters

- `--prompt TEXT`: what to generate. Quote it for the shell; prefer single quotes.
- `--image FILE|URL`: first frame, which makes it image-to-video. Local files are uploaded.
- Video: `--res 480p|720p|1080p` (default 720p), `--duration SECONDS` (default 5),
  `--aspect 16:9|9:16|1:1|4:3|3:4|21:9` (default 16:9), `--audio` / `--no-audio` (default on).
- Image: `--size` (default 1K, or the model's smallest; `cheapgen models` lists each model's
  sizes, such as 1.5K or 3K), `--aspect`.
- Don't use `--duration auto`: the cost is only known afterwards. If the user insists, it needs
  `--allow-auto-duration`, and the quote shows the maximum cost.

## Workflow

1. `cheapgen quote <model> [params] --json` (rule 1). Quote and run take the same parameters.
2. Optional: `cheapgen run <model> --prompt '...' [params] --dry-run --json` shows the exact
   request and estimate and sends nothing. Use it when the user wants to check first, or when
   `needsConfirmation` matters.
3. After the user agrees: `cheapgen run <model> --prompt '...' [params] --wait --json`.
   Results are saved to `./cheapgen-out` (or `--download DIR`). Report the `files` paths, the
   `job` id, and what it cost: `actualUsd` (the charge) if present, otherwise the estimate.
4. Long video jobs: run without `--wait`, tell the user the job id, and later run
   `cheapgen wait <job> --json`.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | Report the result |
| 2 | Bad parameters | Fix them from the message, or ask the user |
| 3 | No provider can take it (no key, balance too low, all rejected, or not offered) | Explain the message; don't retry blindly |
| 4 | Needs confirmation (over the limit or unknown price) | Ask the user (rule 2) |
| 5 | Unknown outcome | Rule 4: stop, don't resubmit |
| 6 | The job failed | Report the error; ask before trying again |
| 7 | Timed out while waiting | The job may still finish: `cheapgen wait <job>` |
| 1 | Unexpected error | Report it |

With `--json`, errors are `{ "error": { code, message, provider, job } }` on stdout.

## Other commands

- `cheapgen providers`: which providers are connected, enabled, and their balances.
- `cheapgen spend [--since YYYY-MM-DD]`: what past runs cost (`charged` where the provider
  reports it, otherwise `estimate`; the provider's bill is authoritative).
- `cheapgen status <job>`: one status check without waiting.

Prices are estimates. Say so when it matters, and never promise an exact charge.
