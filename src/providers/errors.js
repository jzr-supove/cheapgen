// Submit failures, classified by adapters.

/** The provider definitely did not create a job: safe to try the next provider. */
export class SubmitRejected extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'SubmitRejected';
    this.status = status;
    this.code = code;
  }
}

/** A job may exist and may be billed: never fall back automatically. */
export class SubmitUnknown extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'SubmitUnknown';
    this.status = status;
  }
}
