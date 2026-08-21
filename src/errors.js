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

export class EnvironmentLifecycleBusyError extends DevBridgeError {
  constructor(message = 'environment lifecycle mutation is already active') {
    super(message);
    this.code = 'DEVBRIDGE_ENVIRONMENT_LIFECYCLE_BUSY';
  }
}

export class HyperVGuestFileServiceUnavailableError extends DevBridgeError {
  constructor(message = 'Hyper-V guest file service did not become ready') {
    super(message);
    this.code = 'DEVBRIDGE_HYPERV_GUEST_FILE_SERVICE_UNAVAILABLE';
  }
}

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
