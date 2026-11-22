// The local spend log: ~/.cheapgen/spend.jsonl, two lines per job.
// A `submitted` line as soon as the provider accepts the job, and a `finished` line when it
// ends. Prompts are never written here.
import fs from 'node:fs';
import path from 'node:path';

export const spendLogPath = (homedir) => path.join(homedir, '.cheapgen', 'spend.jsonl');

/** Appends one line. `redact` scrubs keys from anything a provider echoed back. */
export function appendSpend(app, line) {
  const file = spendLogPath(app.io.homedir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${app.redact(JSON.stringify({ at: app.io.now().toISOString(), ...line }))}\n`);
}

export function readSpend(homedir) {
  let text;
  try { text = fs.readFileSync(spendLogPath(homedir), 'utf8'); } catch { return []; }
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { /* skip a damaged line rather than lose the rest */ }
  }
  return lines;
}

const isAmount = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/**
 * Joins submitted and finished lines by job id, oldest first. `actualUsd` is what the provider
 * reported charging, or null.
 */
export function joinJobs(lines) {
  const jobs = new Map();
  for (const l of lines) {
    if (!l?.job) continue;
    const j = jobs.get(l.job) ?? { job: l.job, actualUsd: null };
    if (l.event === 'submitted') {
      Object.assign(j, { provider: l.provider ?? l.job.split(':')[0], model: l.model, params: l.params,
        estimateUsd: l.estimateUsd ?? null, priceSource: l.priceSource ?? null, submittedAt: l.at, meta: l.meta });
    } else if (l.event === 'finished') {
      Object.assign(j, { state: l.state, finishedAt: l.at, files: l.files ?? [] });
      if (isAmount(l.actualUsd)) j.actualUsd = l.actualUsd;
    }
    jobs.set(l.job, j);
  }
  return [...jobs.values()].map((j) => ({ state: 'unfinished', ...j }));
}

export const findJob = (homedir, job) => joinJobs(readSpend(homedir)).find((j) => j.job === job) ?? null;
