# cheapgen

Several API providers sell the same AI video and image models at different prices. `cheapgen`
prices your request on each provider you have a key for and sends it to the cheapest one.

It works with [Kie](https://kie.ai), [Replicate](https://replicate.com),
[WaveSpeed](https://wavespeed.ai) and [fal](https://fal.ai). Coding agents such as Claude Code,
Codex, GitHub Copilot and Cursor can use it too, through a skill, an MCP server or a plugin
([Use with AI agents](#use-with-ai-agents)).

```console
$ cheapgen quote seedance-2.0-mini --res 480p --duration 4
seedance-2.0-mini · text-to-video · 480p · 4s · 16:9 · audio on
  kie        $0.0760  live 2026-11-22     ← run would use this
  replicate  $0.160   bundled 2026-11-21
  wavespeed  $0.216   bundled 2026-11-21  (not connected)
  fal        $0.281   bundled 2026-11-21  (not connected)
```

> **Early version.** Kie, WaveSpeed and Replicate have been tried with real image, text-to-video and
> image-to-video runs. fal has only been tried for prices, balance and errors; its generation
> requests were built from its docs. The MCP server and the plugins are checked by tests and, for
> Claude Code and Codex, by the apps' own plugin tools, but haven't yet been used in every app.

## Install

You need [Node.js](https://nodejs.org) 22 or newer. There are no other dependencies.

```sh
npm install -g cheapgen
```

## Add your keys

You need a key from at least one provider. This asks for it and hides what you type:

```sh
cheapgen config set-key kie
```

Use `replicate`, `wavespeed` or `fal` for the others. The key is stored as plain text in
`~/.cheapgen/config.json`, readable only by you on macOS and Linux. Windows can't restrict it the
same way.

Environment variables work too, and win over stored keys: `KIE_API_KEY`, `REPLICATE_API_TOKEN`,
`WAVESPEED_API_KEY`, `FAL_KEY`.

```sh
cheapgen config list          # keys (last 4 characters only) and settings
cheapgen config get-key kie   # is this key set, and where does it come from?
cheapgen providers            # connected providers and their balances
```

## Use

```sh
# What would it cost, and where? Sends nothing to generate.
cheapgen quote seedance-2.0-mini --res 480p --duration 4

# See the exact request without sending it.
cheapgen run seedance-2.0-mini --prompt "a paper boat on a pond" --res 480p --duration 4 --dry-run

# Generate, wait, and save the result to ./cheapgen-out
cheapgen run seedance-2.0-mini --prompt "a paper boat on a pond" --res 480p --duration 4 --wait

# An image
cheapgen run seedream-5.5 --prompt "a red bicycle" --size 1K --aspect 1:1 --wait

# Image to video, from a local file or a URL
cheapgen run seedance-2.0-mini --prompt "the boat drifts away" --image boat.png --wait

# Start now, collect later
cheapgen run seedance-2.0-fast --prompt "a lighthouse at night"
cheapgen wait kie:task_123
```

`cheapgen --help` lists every option. Add `--json` to any command for scripts.

## Models

| Video | Image |
|---|---|
| `seedance-2.0-mini` | `seedream-5.5` |
| `seedance-2.0-fast` | `seedream-5-pro` |
| `seedance-2.0` | `seedream-5-lite` |
| `seedance-2.5-flash` | `nano-banana-2.1` |
| `seedance-2.5` | `nano-banana-pro` |
| | `flux-2-pro` |

`cheapgen models` shows each model's resolutions or sizes, and which providers offer it.

`seedance-2.0` and `seedance-2.5` also come in 4K (`--res 4k`), about $1 to $1.30 a second at the
cheapest provider. The file is 10-bit H.265/HEVC, which some players can't open; VLC and mpv can.

## Spending safely

- **Cost limit.** A run that costs more than $1, or whose price is unknown, stops until you confirm
  it. Change the limit with `cheapgen config set maxCostPerRun 0.5`, or for one run with
  `--max-cost`. `--yes` starts a run even if it is over the limit.
- **No double billing.** If a provider clearly rejects a request, cheapgen tries the next cheapest
  one. If it can't tell whether the job was created, it stops and says so (exit code 5) instead of
  risking a second charge.
- **Balances.** Providers whose reported balance can't cover the request are skipped. Replicate has
  no balance API.
- **Spend log.** `cheapgen spend` summarizes your runs: the actual charge where the provider reports
  it (Kie), $0 for failed Replicate jobs, which Replicate doesn't bill, and otherwise the estimate.
  The log stays on your computer and never contains prompts or keys.

Every price is an estimate and is shown with its source and date. Kie, WaveSpeed and fal prices are
read live when possible; otherwise cheapgen uses the prices bundled in `data/prices.json`. Your
provider's bill is authoritative.

## Configuration

Settings live in `~/.cheapgen/config.json`. A `.cheapgen.json` in the current folder overrides them.

```json
{
  "strategy": "cheapest",
  "prefer": ["kie", "replicate"],
  "maxCostPerRun": 1.0,
  "providers": { "fal": { "enabled": false } },
  "models": { "seedance-2.5": { "provider": "replicate" } }
}
```

- `strategy`: `cheapest`, or `preferred` to use the first provider in `prefer` that supports the
  request.
- `providers.<id>.enabled`: turn a provider off without removing its key.
- `models.<id>.provider`: always use one provider for a model.

For one run, use `--provider ID` or `--exclude ID`.

## Use with AI agents

The package includes a skill that lets a coding agent quote and run generations for you. It
quotes first and asks before spending anything. After installing cheapgen, add the skill:

```sh
cheapgen skill install
```

This finds the agents on your computer and copies the skill into their folders:

| Agent | Folder | Install for it alone |
|---|---|---|
| Claude Code | `~/.claude/skills/cheapgen` | `cheapgen skill install --agent claude` |
| Codex, OpenCode, Cursor and other [Agent Skills](https://agentskills.io) agents | `~/.agents/skills/cheapgen` | `cheapgen skill install --agent codex` |
| GitHub Copilot (CLI and VS Code) | `~/.copilot/skills/cheapgen` | `cheapgen skill install --agent copilot` |
| Cursor only | `~/.cursor/skills/cheapgen` | `cheapgen skill install --agent cursor` |

- `--project` installs into the current folder instead (`.claude/skills`, `.agents/skills`), so
  you can commit it with a project. For VS Code, add `--agent copilot`, which uses
  `.github/skills`.
- `--agent opencode` is the same as `--agent codex`: OpenCode reads `~/.agents/skills`.
- After `npm update -g cheapgen`, run `cheapgen skill install` again to refresh the copies.
- `cheapgen skill uninstall` removes them. It only ever touches the `cheapgen` skill folder.
- For other agents, `npx skills add jzr-supove/cheapgen` installs the same skill from GitHub.

### Plugins

The plugins bundle the skill and the MCP server below, and start it with
`npx -y cheapgen@latest mcp`, so you don't need to install cheapgen first.

```sh
# Claude Code, inside a session (asks for your keys and keeps them in secure storage)
/plugin marketplace add jzr-supove/cheapgen
/plugin install cheapgen@cheapgen

# Codex
codex plugin marketplace add jzr-supove/cheapgen
codex plugin add cheapgen@cheapgen

# GitHub Copilot CLI
copilot plugin install jzr-supove/cheapgen

# Antigravity CLI
agy plugin install https://github.com/jzr-supove/cheapgen

# Cursor: Customize, then import a plugin from the GitHub repository jzr-supove/cheapgen

# Gemini CLI, where you still have it
gemini extensions install https://github.com/jzr-supove/cheapgen
```

Every key setting is optional. Keys stored with `npx cheapgen config set-key <provider>` work
everywhere. Only Claude Code and Gemini CLI ask for keys, and Codex and Copilot don't pass your
environment variables to plugin servers, so with the others, store your keys that way.

### MCP server

`cheapgen mcp` runs an [MCP](https://modelcontextprotocol.io) server on stdin and stdout, for
apps that use MCP tools rather than skills. With cheapgen installed, add it with the lines below.
Without installing it, use `npx -y cheapgen@latest mcp` as the command instead.

```sh
claude mcp add cheapgen -- cheapgen mcp     # Claude Code
codex mcp add cheapgen -- cheapgen mcp      # Codex
copilot mcp add cheapgen -- cheapgen mcp    # GitHub Copilot CLI, also used by VS Code
```

For OpenCode, add it to `~/.config/opencode/opencode.json`:

```json
{ "mcp": { "servers": { "cheapgen": { "type": "local", "command": ["cheapgen", "mcp"] } } } }
```

For Cursor, this button adds it in one click (it runs `npx -y cheapgen@latest mcp`):

[![Add cheapgen to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cheapgen&config=eyJjb21tYW5kIjoibnB4IC15IGNoZWFwZ2VuQGxhdGVzdCBtY3AifQ%3D%3D)

For Cursor by hand (`~/.cursor/mcp.json`), Claude Desktop and other apps, add this to their MCP
settings:

```json
{ "mcpServers": { "cheapgen": { "command": "cheapgen", "args": ["mcp"] } } }
```

Store your keys with `cheapgen config set-key`, since not every app passes environment variables
on to the servers it starts.

It has seven tools: `models`, `providers`, `quote`, `run`, `job_status`, `wait_job` and `spend`.

- **`run` only takes a quote.** The agent calls `quote` first, and `run` starts exactly the
  request that was priced. A quote lasts 10 minutes and starts one job. If the price went up
  since the quote, `run` stops and asks for a new quote.
- **The cost limit stays yours.** No tool can raise it. Above the limit, apps that support it ask
  you directly to confirm the price; the agent can't answer for you. Other apps refuse the run,
  and you can raise `maxCostPerRun` or use the CLI.
- `run` returns a job id at once. `wait_job` waits up to two minutes per call and saves the result
  to `./cheapgen-out` in the folder the app started the server in. If that is a plugin's own
  folder or a drive root, it uses `~/cheapgen-out` instead.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Unexpected error |
| 2 | Bad arguments or configuration |
| 3 | No provider can take the request |
| 4 | Needs confirmation: over the cost limit, or the price is unknown |
| 5 | Unknown outcome: a job may exist. Check the provider before trying again |
| 6 | The job failed |
| 7 | Timed out waiting; the job may still finish |

## Development

```sh
npm test
```

Tests make no network calls and spend no credits.

## License

[MIT](LICENSE). cheapgen is not affiliated with Kie, Replicate, WaveSpeed or fal.
