// MCP tools. Each one runs the matching CLI command in-process with --json, so validation,
// key redaction, the cost limit and the spend log work exactly as they do on the command line.
// `run` is the only tool that spends money, and it only takes a quoteId from `quote`.
import crypto from 'node:crypto';
import path from 'node:path';
import { main } from '../cli/main.js';
import { RpcError } from './errors.js';

export const QUOTE_TTL_MS = 10 * 60_000;
const STATE_TTL_MS = 5 * 60_000;
const WAIT_DEFAULT_SECONDS = 60;

const str = (description) => ({ type: 'string', description });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const REQUEST_PROPERTIES = {
  model: str('Model id from the `models` tool, e.g. seedance-2.0-mini or seedream-5.5.'),
  prompt: str('What to generate. Needed before the quote can be used with `run`.'),
  image: str('First frame for image-to-video: an https URL or a local file path.'),
  resolution: str('Video resolution: 480p, 720p, 1080p or 4k (only some models). Default 720p.'),
  size: str('Image size, e.g. 1K, 2K or 4K. Default 1K, or the model\'s smallest.'),
  duration: { type: 'number', description: 'Video length in seconds. Default 5.' },
  aspect: str('Aspect ratio, e.g. 16:9, 9:16 or 1:1. Default 16:9.'),
  audio: { type: 'boolean', description: 'Generate audio with the video (models that support it). Default true.' },
  provider: str('Use only this provider: kie, replicate, wavespeed or fal.'),
  exclude: { type: 'array', items: { type: 'string' }, description: 'Providers to skip.' },
};

const closed = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_DEFINITIONS = [
  {
    name: 'models',
    title: 'List models',
    description: 'Lists the video and image models cheapgen supports, with their resolutions or sizes and the providers that offer each.',
    inputSchema: closed({ search: str('Only models whose id or name contains this text.') }),
    annotations: { title: 'List models', ...READ_ONLY },
  },
  {
    name: 'providers',
    title: 'List providers',
    description: 'Lists the providers (Kie, Replicate, WaveSpeed, fal), whether each has a key, and their balances where the provider reports one.',
    inputSchema: closed({}),
    annotations: { title: 'List providers', ...READ_ONLY },
  },
  {
    name: 'quote',
    title: 'Price a generation',
    description: 'Prices a generation on every provider and picks the cheapest connected one. Spends nothing. Returns a quoteId, '
      + 'valid for 10 minutes, that `run` needs. Tell the user the provider and price before running.',
    inputSchema: closed(REQUEST_PROPERTIES, ['model']),
    annotations: { title: 'Price a generation', ...READ_ONLY },
  },
  {
    name: 'run',
    title: 'Start a generation (spends money)',
    description: 'Starts the generation priced by a quote, on the cheapest provider. This spends the user\'s money (provider credits, '
      + 'in USD). Call it only after the user agreed to the quoted price. Above the user\'s cost limit the user is asked to confirm. '
      + 'Returns a job id at once; use `wait_job` for the result. Never call it again after an unknown_outcome error.',
    inputSchema: closed({ quoteId: str('The quoteId returned by `quote`.') }, ['quoteId']),
    annotations: { title: 'Start a generation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'job_status',
    title: 'Check a job',
    description: 'Checks a job once and returns its state (running, succeeded, failed) and any result URLs. Job ids look like kie:task_123.',
    inputSchema: closed({ job: str('Job id from `run`, e.g. kie:task_123.') }, ['job']),
    annotations: { title: 'Check a job', ...READ_ONLY },
  },
  {
    name: 'wait_job',
    title: 'Wait for a job',
    description: 'Waits for a job to finish, up to timeoutSeconds, then saves the results to the cheapgen-out folder and returns the file paths. '
      + 'If the job is still running when the time is up, it returns state "running"; call it again to keep waiting.',
    inputSchema: closed({
      job: str('Job id from `run`, e.g. kie:task_123.'),
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120, description: `How long to wait. Default ${WAIT_DEFAULT_SECONDS}.` },
    }, ['job']),
    annotations: { title: 'Wait for a job', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'spend',
    title: 'Summarize spending',
    description: 'Summarizes the local spend log: each job with its estimate, the actual charge where the provider reports it, and totals.',
    inputSchema: closed({ since: str('Only jobs from this date on, e.g. 2026-11-01.') }),
    annotations: { title: 'Summarize spending', ...READ_ONLY },
  },
];

const BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------------------------
// Results

const textOf = (obj) => JSON.stringify(obj, null, 2);

function result(structured, { isError = false, notes = '' } = {}) {
  const content = [{ type: 'text', text: textOf(structured) }];
  if (notes.trim()) content.push({ type: 'text', text: notes.trim() });
  return { content, structuredContent: structured, ...(isError ? { isError: true } : {}) };
}

const failure = (code, message, extra = {}) => result({ error: { code, message, provider: null, job: null, ...extra } }, { isError: true });

// ---------------------------------------------------------------------------------------------
// Arguments

/** Checks arguments against the tool's (simple, flat) schema. Returns an error message or null. */
function invalidArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) return `unknown argument "${key}"`;
  }
  for (const key of schema.required) {
    if (args[key] === undefined) return `missing required argument "${key}"`;
  }
  for (const [key, value] of Object.entries(args)) {
    const p = schema.properties[key];
    const bad = (want) => `"${key}" must be ${want}`;
    if (p.type === 'string' && typeof value !== 'string') return bad('a string');
    if (p.type === 'boolean' && typeof value !== 'boolean') return bad('true or false');
    if (p.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return bad('a number');
    if (p.type === 'integer' && !Number.isInteger(value)) return bad('a whole number');
    if (p.type === 'array' && (!Array.isArray(value) || value.some((v) => typeof v !== p.items.type))) return bad('a list of strings');
    if (p.minimum !== undefined && value < p.minimum) return bad(`at least ${p.minimum}`);
    if (p.maximum !== undefined && value > p.maximum) return bad(`at most ${p.maximum}`);
  }
  return null;
}

function requestArgs(a) {
  const args = [a.model];
  const opt = (flag, v) => { if (v !== undefined) args.push(flag, String(v)); };
  opt('--prompt', a.prompt);
  opt('--image', a.image);
  opt('--res', a.resolution);
  opt('--size', a.size);
  opt('--duration', a.duration);
  opt('--aspect', a.aspect);
  if (a.audio !== undefined) args.push(a.audio ? '--audio' : '--no-audio');
  opt('--provider', a.provider);
  for (const id of a.exclude ?? []) args.push('--exclude', id);
  return args;
}

/** Where results are saved: <cwd>/cheapgen-out, or <home>/cheapgen-out when the server runs at a filesystem root. */
function downloadDir(io) {
  const cwd = path.resolve(io.cwd);
  return path.join(path.parse(cwd).root === cwd ? io.homedir : cwd, 'cheapgen-out');
}

// ---------------------------------------------------------------------------------------------
// Running CLI commands

/** Runs `cheapgen <args> --json` in-process. Never reads the MCP connection's stdin. */
async function cli(io, args) {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--json'], {
    ...io,
    stdout: { write(s) { stdout += s; return true; } },
    stderr: { write(s) { stderr += s; return true; } },
    stdin: '',
    readStdin: async () => '',
    promptSecret: null,
  });
  let json;
  try { json = JSON.parse(stdout); } catch {
    json = { error: { code: 'bug', message: `cheapgen printed no JSON (exit ${code})`, provider: null, job: null } };
  }
  return { code, json, notes: stderr };
}

const fromCli = ({ code, json, notes }) => result(json, { isError: code !== 0, notes });

// ---------------------------------------------------------------------------------------------
// Tool handlers

const HANDLERS = {
  models: (ctx, a) => cli(ctx.io, ['models', ...(a.search === undefined ? [] : ['--search', a.search])]).then(fromCli),
  providers: (ctx) => cli(ctx.io, ['providers']).then(fromCli),
  spend: (ctx, a) => cli(ctx.io, ['spend', ...(a.since === undefined ? [] : ['--since', a.since])]).then(fromCli),
  job_status: (ctx, a) => cli(ctx.io, ['status', a.job]).then(fromCli),

  async wait_job(ctx, a) {
    const seconds = a.timeoutSeconds ?? WAIT_DEFAULT_SECONDS;
    const r = await cli(ctx.io, ['wait', a.job, '--timeout', String(seconds), '--download', downloadDir(ctx.io)]);
    if (r.code === 7) {
      return result({ job: a.job, provider: r.json.error?.provider ?? null, state: 'running',
        message: `Still running after ${seconds} seconds. Call wait_job again to keep waiting.` }, { notes: r.notes });
    }
    // Absolute paths, so the agent can open them wherever it runs.
    if (r.code === 0 && Array.isArray(r.json.files)) r.json.files = r.json.files.map((p) => path.resolve(ctx.io.cwd, p));
    return fromCli(r);
  },

  async quote(ctx, a) {
    const args = requestArgs(a);
    const r = await cli(ctx.io, ['quote', ...args]);
    if (r.code !== 0) return fromCli(r);
    const now = ctx.io.now().getTime();
    const quoteId = `q_${crypto.randomBytes(12).toString('base64url')}`;
    const chosen = r.json.quotes?.find((q) => q.chosen) ?? null;
    ctx.state.quotes.set(quoteId, {
      args, hasPrompt: typeof a.prompt === 'string' && a.prompt.trim() !== '',
      params: r.json.params ?? null, createdAt: now, used: false, usd: chosen?.usd ?? null,
    });
    return result({ ...r.json, quoteId, expiresAt: new Date(now + QUOTE_TTL_MS).toISOString() }, { notes: r.notes });
  },

  run: runQuote,
};

/** Calls one tool. Unknown tools and a missing name are JSON-RPC errors; bad arguments are tool errors. */
export async function callTool(ctx, params, call) {
  const name = params?.name;
  if (typeof name !== 'string' || !name) throw new RpcError(-32602, 'tools/call needs a tool name');
  const tool = BY_NAME.get(name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  const args = params.arguments ?? {};
  const bad = invalidArguments(tool.inputSchema, args);
  if (bad) return failure('usage', `${name}: ${bad}`);
  return HANDLERS[name](ctx, args, params, call);
}

// ---------------------------------------------------------------------------------------------
// run: the only spending tool

const fmtUsd = (x) => (x === null || x === undefined ? 'an unknown amount' : `$${x < 0.1 ? x.toFixed(4) : x.toFixed(3)}`);

function describeRequest(params) {
  if (!params) return 'this generation';
  return Object.entries(params).filter(([k, v]) => v !== undefined && v !== null && k !== 'prompt')
    .map(([k, v]) => `${k} ${v}`).join(', ');
}

async function runQuote(ctx, a, params, call) {
  const q = ctx.state.quotes.get(a.quoteId);
  const now = ctx.io.now().getTime();
  if (!q || now - q.createdAt > QUOTE_TTL_MS) {
    return failure('quote_expired', 'This quote is unknown or older than 10 minutes. Call `quote` again.');
  }
  if (q.used) return failure('quote_used', 'This quote was already used to start a job. Call `quote` again for another run.');
  if (!q.hasPrompt) return failure('needs_prompt', 'This quote has no prompt. Call `quote` again with a prompt.');

  // Price it again: live prices and balances can change after the quote.
  const dry = await cli(ctx.io, ['run', ...q.args, '--dry-run']);
  if (dry.code !== 0) return fromCli(dry);
  const d = dry.json;
  if (q.usd !== null && d.estimateUsd !== null && d.estimateUsd > q.usd + 1e-9) {
    return failure('price_changed', `The price went up from ${fmtUsd(q.usd)} to ${fmtUsd(d.estimateUsd)} on ${d.provider}. `
      + 'Call `quote` again and check the new price with the user.', { provider: d.provider });
  }
  if (!d.needsConfirmation) return submit(ctx, q, []);

  const what = `${fmtUsd(d.estimateUsd)} on ${d.provider} for ${q.args[0]} (${describeRequest(q.params)})`;
  const why = d.estimateUsd === null ? 'Its price is unknown.' : `That is over your cost limit of ${fmtUsd(d.limitUsd)}.`;
  const overrideArgs = ['--yes', ...(d.estimateUsd === null ? [] : ['--max-cost', String(d.estimateUsd)])];
  const elicitation = {
    message: `Spend ${what}? ${why}`,
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: 'Spend this money', description: `Start the run and spend ${fmtUsd(d.estimateUsd)}.` } },
      required: ['confirm'],
    },
  };

  if (!call.capabilities?.elicitation) {
    const code = d.estimateUsd === null ? 'price_unknown' : 'over_limit';
    return failure(code, `${what}: ${why} This app can't ask you to confirm, so nothing was sent. Raise the limit with `
      + '`cheapgen config set maxCostPerRun <USD>`, or run it from the command line with --yes.', { provider: d.provider });
  }

  if (call.modern) {
    if (params.requestState === undefined && params.inputResponses === undefined) {
      return {
        resultType: 'input_required',
        inputRequests: { confirm_spend: { method: 'elicitation/create', params: { mode: 'form', ...elicitation } } },
        requestState: signState(ctx, { quoteId: a.quoteId, exp: now + STATE_TTL_MS }),
      };
    }
    const st = verifyState(ctx, params.requestState);
    if (!st || st.quoteId !== a.quoteId || now > st.exp) {
      return failure('bad_request_state', 'The confirmation is invalid or too old. Call `run` again to ask once more.');
    }
    const answer = params.inputResponses?.confirm_spend;
    return accepted(answer) ? submit(ctx, q, overrideArgs) : declined();
  }

  let answer;
  try {
    const p = ctx.state.legacy?.version === '2025-11-25' ? { mode: 'form', ...elicitation } : elicitation;
    answer = await ctx.requestClient('elicitation/create', p);
  } catch {
    return declined();
  }
  return accepted(answer) ? submit(ctx, q, overrideArgs) : declined();
}

function accepted(answer) {
  const r = answer?.result ?? answer;
  return r?.action === 'accept' && r?.content?.confirm === true;
}

const declined = () => failure('declined', 'The run was not confirmed, so nothing was sent and nothing was spent.');

async function submit(ctx, q, extra) {
  q.used = true;
  const r = await cli(ctx.io, ['run', ...q.args, ...extra]);
  // A clean refusal before anything was sent leaves the quote usable. A submit, an unknown
  // outcome (exit 5) or an unexpected error uses it up, so it can never be charged twice.
  if ([2, 3, 4].includes(r.code)) q.used = false;
  return fromCli(r);
}

// requestState: base64url(JSON) + "." + HMAC-SHA256, signed with a random key per server process.
function signState(ctx, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, n: crypto.randomBytes(8).toString('base64url') })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', ctx.state.stateKey).update(body).digest('base64url')}`;
}

function verifyState(ctx, token) {
  if (typeof token !== 'string') return null;
  const [body, mac, more] = token.split('.');
  if (!body || !mac || more !== undefined) return null;
  // Compare the encoded text, not decoded bytes: base64url decoding ignores the spare bits of the
  // last character, so two different strings can decode to the same bytes.
  const want = Buffer.from(crypto.createHmac('sha256', ctx.state.stateKey).update(body).digest('base64url'));
  const got = Buffer.from(mac);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
