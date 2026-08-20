import { PolicyError } from '../errors.js';
import {
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  normalizeRepositoryExecutionRequest,
  normalizeRepositoryExecutionResult,
  normalizeRepositoryExecutionStatus,
} from './repository-execution.js';

const REQUIRED_SESSION_METHODS = Object.freeze(['prepare', 'input', 'run', 'output', 'collect']);

function assertSession(value) {
  if (!value || typeof value !== 'object' || REQUIRED_SESSION_METHODS.some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('repository execution session contract is incomplete');
  }
  return value;
}

function observedOutcome(raw) {
  if (!raw || typeof raw !== 'object') throw new PolicyError('repository execution returned an invalid completion');
  if (raw.completion !== 'observed') {
    throw new PolicyError(`repository execution completion is ${raw.completion ?? 'invalid'}; refusing to infer success`);
  }
  if (!raw.result || typeof raw.result !== 'object') throw new PolicyError('repository execution did not return an observed result');
  return raw.result;
}

function preparedIdentity(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.identity !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(raw.identity)) {
    throw new PolicyError('repository execution preparation did not return a bounded evidence identity');
  }
  return raw.identity;
}

export class RepositoryEnvironmentExecution {
  #status;
  #open;

  constructor({ status, open }) {
    this.#status = normalizeRepositoryExecutionStatus(status);
    if (typeof open !== 'function') throw new TypeError('repository execution open must be a function');
    this.#open = open;
  }

  inspect() { return this.#status; }

  async execute(rawRequest) {
    const request = normalizeRepositoryExecutionRequest(rawRequest);
    if (this.#status.ready !== true) {
      throw new PolicyError(`repository execution is unavailable: ${this.#status.reason ?? 'execution boundary is not ready'}`);
    }
    if (request.signal?.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new PolicyError('repository execution aborted before admission');

    const session = assertSession(await this.#open(structuredClone(request.scope)));
    const prepared = await session.prepare({ signal: request.signal, onActivity: request.onActivity });
    const identity = preparedIdentity(prepared);

    for (const transfer of request.transfers) {
      if (transfer.direction === 'input') {
        await session.input(transfer.name, transfer.port, { signal: request.signal });
      }
    }

    const outcome = await session.run({
      operation: request.operation,
      invocation: structuredClone(request.invocation),
      environment: structuredClone(request.environment),
      limits: structuredClone(request.limits),
      stdin: request.stdin,
      signal: request.signal,
      onActivity: request.onActivity,
    });
    const result = observedOutcome(outcome);

    if (result.timedOut !== true && result.aborted !== true) {
      for (const transfer of request.transfers) {
        if (transfer.direction === 'output') {
          await session.output(transfer.name, transfer.port, { signal: request.signal });
        }
      }
      await session.collect({ identity, operation: request.operation, signal: request.signal });
    }

    return normalizeRepositoryExecutionResult({
      protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
      outputTruncated: result.outputTruncated === true,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      startedAt: result.startedAt ?? null,
      finishedAt: result.finishedAt ?? null,
      lastOutputAt: result.lastOutputAt ?? null,
      evidence: { identity, scope: request.scope },
    });
  }
}
