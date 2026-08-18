export class PatchPollerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends PatchPollerError {}
export class ProtocolError extends PatchPollerError {}
export class PolicyError extends PatchPollerError {}

export class RateLimitError extends PatchPollerError {
  constructor(message, { retryAt = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.retryAt = retryAt;
  }
}
export class HttpError extends PatchPollerError {
  constructor(message, { status, body = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.status = status;
    this.body = body;
  }
}
