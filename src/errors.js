export class DevBridgeError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends DevBridgeError {}
export class ProtocolError extends DevBridgeError {}
export class PolicyError extends DevBridgeError {}
export class CandidateValidationError extends DevBridgeError {}
export class TaskLeaseLostError extends DevBridgeError {}

export class BaselineReverificationRequiredError extends CandidateValidationError {
  constructor(message, reconciliation = {}, options = {}) {
    super(message, options);
    this.reconciliation = structuredClone(reconciliation);
  }
}

export class BaselineReconciliationError extends CandidateValidationError {
  constructor(message, { kind = 'unknown', files = [], reconciliation = {}, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.kind = kind;
    this.files = [...files];
    this.reconciliation = structuredClone(reconciliation);
  }
}

export class GitCommandError extends DevBridgeError {
  constructor(message, { args = [], cwd = null, exitCode = null, signal = null, stdout = '', stderr = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.args = [...args];
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class RepositoryAdmissionError extends GitCommandError {
  constructor(message, { code = 'REPOSITORY_ADMISSION_FAILED', phase = 'unknown', kind = 'git-failure', repair = null, retryable = false, ...details } = {}) {
    super(message, details);
    this.code = code;
    this.phase = phase;
    this.kind = kind;
    this.repair = repair == null ? null : String(repair);
    this.retryable = retryable === true;
  }
}

export class RateLimitError extends DevBridgeError {
  constructor(message, { retryAt = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.retryAt = retryAt;
  }
}
export class HttpError extends DevBridgeError {
  constructor(message, { status, body = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.status = status;
    this.body = body;
  }
}
