// Errors that end a command with a specific exit code.

export const EXIT = Object.freeze({
  OK: 0,
  BUG: 1,
  USAGE: 2,
  NO_PROVIDER: 3,
  NEEDS_CONFIRMATION: 4,
  UNKNOWN_OUTCOME: 5,
  JOB_FAILED: 6,
  TIMED_OUT: 7,
});

/** An error the CLI reports to the user and turns into an exit code. */
export class CliError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} code      short machine-readable code for --json output
   * @param {string} message   human-readable message
   * @param {{ provider?: string, job?: string }} [extra]
   */
  constructor(exitCode, code, message, extra = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.provider = extra.provider ?? null;
    this.job = extra.job ?? null;
  }
}

export const usageError = (message) => new CliError(EXIT.USAGE, 'usage', message);
