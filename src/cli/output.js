// Output helpers. With --json, stdout carries exactly one JSON document (a result or
// `{ "error": { code, message, provider, job } }`); notices go to stderr.
// Without --json, results go to stdout and notices and errors to stderr.

export function createOutput({ stdout, stderr, json }) {
  let jsonMode = json;
  return {
    get json() { return jsonMode; },
    setJson(v) { jsonMode = v; },
    /** A command's result: an object for --json, or text for people. */
    result(obj, text) {
      if (jsonMode) stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
      else stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    text(s) { stdout.write(s); },
    notice(msg) { stderr.write(`${msg}\n`); },
    warn(msg) { stderr.write(`warning: ${msg}\n`); },
    error(err) {
      if (jsonMode) {
        stdout.write(`${JSON.stringify({ error: { code: err.code, message: err.message, provider: err.provider ?? null,
          job: err.job ?? null } }, null, 2)}\n`);
      } else {
        stderr.write(`cheapgen: ${err.message}\n`);
      }
    },
  };
}

export const usd = (x) => (x === null || x === undefined ? 'price unknown' : `$${x < 0.1 ? x.toFixed(4) : x.toFixed(3)}`);

/** Left-aligned columns. */
export function table(rows) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, String(c).length); });
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n');
}
