import { quote } from './quote.js';
import { run } from './run.js';
import { status, wait } from './jobs.js';
import { providers, models, spend, prices } from './info.js';
import { config } from './config.js';

export const COMMANDS = { providers, models, quote, run, status, wait, spend, prices, config };

export const HELP = `cheapgen: send each AI video or image request to the cheapest connected provider.

Usage:
  cheapgen providers                 list providers, keys, and balances
  cheapgen models [--search TEXT]    list the supported models
  cheapgen quote <model> [params]    price a request on every provider
  cheapgen run <model> --prompt TEXT [params] [options]
  cheapgen status <job>              check a job (job ids look like kie:task_123)
  cheapgen wait <job>                wait for a job, then download it
  cheapgen spend [--since DATE]      summarize the local spend log
  cheapgen prices [model] [--check]  show bundled prices and how old they are
  cheapgen config set-key <provider> store an API key (asks for it)
  cheapgen config get-key <provider> show whether a key is set (last 4 characters)
  cheapgen config list               list keys and settings
  cheapgen config show | path | set <key> <value>

Parameters:
  --prompt TEXT      what to generate
  --image FILE|URL   first frame (image-to-video)
  --res 480p|720p|1080p   (default 720p)      --size 1K|2K|4K|... (images; default 1K, or the model's smallest)
  --duration SECONDS (default 5)              --aspect 16:9|9:16|1:1|... (default 16:9)
  --audio | --no-audio (default on)           --allow-auto-duration (accept the maximum cost)

Run options:
  --provider ID      use this provider only     --exclude ID   skip a provider for this run
  --max-cost USD     cost limit for this run     --yes          start even if over the limit
  --dry-run          show the request and estimate, send nothing
  --wait             wait for the result         --timeout SECONDS
  --download DIR     where to save results (default ./cheapgen-out)   --no-download
  --json             machine-readable output

Keys: set KIE_API_KEY, REPLICATE_API_TOKEN, WAVESPEED_API_KEY or FAL_KEY, or store one with
\`cheapgen config set-key <provider>\`, which asks for the key and hides it.
`;
