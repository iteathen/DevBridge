import {
  ACCELERATOR_BROKER_REASON,
  ACCELERATOR_BROKER_STATE,
  assertAcceleratorBrokerObservationTransition,
  classifyAcceleratorBrokerExecuteReplay,
  createAcceleratorBrokerObservation,
  digestAcceleratorBrokerCancelRequest,
  digestAcceleratorBrokerExecuteRequest,
  isAcceleratorBrokerTerminalState,
  matchAcceleratorBrokerBinding,
  normalizeAcceleratorBrokerCancelRequest,
  normalizeAcceleratorBrokerExecuteRequest,
  normalizeAcceleratorBrokerObservation,
} from './accelerator-broker-protocol.js';
import {
  acceleratorBrokerCancelLedgerKey,
  acceleratorBrokerLedgerKey,
  advanceAcceleratorBrokerLedgerRecord,
  createAcceleratorBrokerLedgerRecord,
  normalizeAcceleratorBrokerLedgerRecord,
} from './accelerator-broker-ledger.js';

const MAX_CAS_ATTEMPTS = 8;

function assertPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`accelerator broker ${name} contract is incomplete`);
  }
  return value;
}

function same(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function observationFor(request, requestDigest, state, reason = null, result = null) {
  return createAcceleratorBrokerObservation({
    requestId: request.requestId,
    executionId: request.executionId,
    requestDigest,
    binding: request.binding,
    api: request.api,
    topology: request.topology,
    operation: request.operation,
    state,
    reason,
    result,
  });
}

function unknownObservation(record) {
  return observationFor(record.request, record.requestDigest, ACCELERATOR_BROKER_STATE.UNKNOWN, ACCELERATOR_BROKER_REASON.STATE_UNKNOWN);
}

function rejectedObservation(request, requestDigest, reason) {
  return observationFor(request, requestDigest, ACCELERATOR_BROKER_STATE.REJECTED, reason);
}

function failedObservation(record, reason = ACCELERATOR_BROKER_REASON.EXECUTION_FAILED) {
  return observationFor(record.request, record.requestDigest, ACCELERATOR_BROKER_STATE.FAILED, reason);
}

function exactObservationIdentity(observation, record) {
  return observation.requestId === record.request.requestId
    && observation.executionId === record.request.executionId
    && observation.requestDigest === record.requestDigest
    && observation.api === record.request.api
    && observation.topology === record.request.topology
    && observation.operation === record.request.operation
    && same(observation.binding, record.request.binding);
}

function verifiesCanary(request, observation) {
  if (observation.state !== ACCELERATOR_BROKER_STATE.SUCCEEDED) return true;
  if (!observation.result || !Array.isArray(observation.result.values)) return false;
  const { left, right } = request.input;
  if (observation.result.values.length !== left.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const expected = (left[index] + right[index]) >>> 0;
    if (observation.result.values[index] !== expected) return false;
  }
  return true;
}

function normalizeBackendObservation(record, raw) {
  try {
    const observed = normalizeAcceleratorBrokerObservation(raw);
    if (!exactObservationIdentity(observed, record)) return unknownObservation(record);
    const candidate = verifiesCanary(record.request, observed) ? observed : failedObservation(record);
    try {
      return assertAcceleratorBrokerObservationTransition(record.observation, candidate);
    } catch {
      return unknownObservation(record);
    }
  } catch {
    return unknownObservation(record);
  }
}

function keyMatches(left, right) {
  return left.sessionIdentity === right.sessionIdentity
    && left.sessionGeneration === right.sessionGeneration
    && left.requestId === right.requestId;
}

export class AcceleratorBrokerCore {
  #authority;
  #ledger;
  #backend;

  constructor({ authority, ledger, backend } = {}) {
    this.#authority = assertPort(authority, ['resolveExpectedBinding'], 'binding authority');
    this.#ledger = assertPort(ledger, ['load', 'create', 'compareAndSwap'], 'ledger');
    this.#backend = assertPort(backend, ['ensureExecution', 'observeExecution', 'ensureCancellation'], 'backend');
  }

  async #currentBinding(request) {
    let expected;
    try {
      expected = await this.#authority.resolveExpectedBinding(Object.freeze({
        profile: request.binding.profile,
        session: request.binding.session,
      }));
    } catch {
      return null;
    }
    if (expected == null) return null;
    try {
      return matchAcceleratorBrokerBinding(request.binding, expected).matched ? expected : false;
    } catch {
      return null;
    }
  }

  async #load(key) {
    const raw = await this.#ledger.load(key);
    if (raw == null) return null;
    const record = normalizeAcceleratorBrokerLedgerRecord(raw);
    if (!keyMatches(acceleratorBrokerLedgerKey(record.request), key)) throw new Error('accelerator broker ledger returned another request');
    return record;
  }

  async #createTerminal(request, requestDigest, reason) {
    const key = acceleratorBrokerLedgerKey(request);
    const record = createAcceleratorBrokerLedgerRecord({
      request,
      observation: rejectedObservation(request, requestDigest, reason),
    });
    const created = await this.#ledger.create(key, record);
    if (created === true) return record.observation;
    const existing = await this.#load(key);
    if (!existing) throw new Error('accelerator broker ledger create outcome is ambiguous');
    return this.#replayOrConflict(existing, request, false);
  }

  async #commitObservation(rawRecord, rawObservation) {
    let current = normalizeAcceleratorBrokerLedgerRecord(rawRecord);
    const candidate = normalizeBackendObservation(current, rawObservation);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      if (isAcceleratorBrokerTerminalState(current.observation.state)) return current;
      if (same(current.observation, candidate)) return current;
      let next;
      try {
        next = advanceAcceleratorBrokerLedgerRecord(current, { observation: candidate });
      } catch {
        return current;
      }
      const key = acceleratorBrokerLedgerKey(current.request);
      if (await this.#ledger.compareAndSwap(key, current.revision, next) === true) return next;
      const reloaded = await this.#load(key);
      if (!reloaded) throw new Error('accelerator broker ledger disappeared during reconciliation');
      current = reloaded;
    }
    throw new Error('accelerator broker ledger reconciliation did not converge');
  }

  async #commitUnknown(record) {
    return this.#commitObservation(record, unknownObservation(record));
  }

  async #bindingStillCurrent(record) {
    if (isAcceleratorBrokerTerminalState(record.observation.state)) return true;
    const current = await this.#currentBinding(record.request);
    return current !== false && current != null;
  }

  async #observeBackend(record) {
    if (isAcceleratorBrokerTerminalState(record.observation.state)) return record;
    if (!(await this.#bindingStillCurrent(record))) return this.#commitUnknown(record);
    let raw;
    try {
      raw = await this.#backend.observeExecution(Object.freeze({
        request: record.request,
        requestDigest: record.requestDigest,
      }));
    } catch {
      raw = null;
    }
    if (raw == null) return this.#commitUnknown(record);
    return this.#commitObservation(record, raw);
  }

  async #ensureExecution(record) {
    if (isAcceleratorBrokerTerminalState(record.observation.state)) return record;
    if (!(await this.#bindingStillCurrent(record))) return this.#commitUnknown(record);
    let raw;
    try {
      raw = await this.#backend.ensureExecution(Object.freeze({
        request: record.request,
        requestDigest: record.requestDigest,
      }));
    } catch {
      return this.#observeBackend(record);
    }
    if (raw == null) return this.#observeBackend(record);
    return this.#commitObservation(record, raw);
  }

  async #ensureCancellation(record) {
    if (isAcceleratorBrokerTerminalState(record.observation.state)) return record;
    if (!record.cancelIntent) return this.#observeBackend(record);
    if (!(await this.#bindingStillCurrent(record))) return this.#commitUnknown(record);
    let raw;
    try {
      raw = await this.#backend.ensureCancellation(Object.freeze({
        request: record.request,
        requestDigest: record.requestDigest,
        cancel: record.cancelIntent.request,
        cancelDigest: record.cancelIntent.digest,
      }));
    } catch {
      return this.#observeBackend(record);
    }
    if (raw == null) return this.#observeBackend(record);
    return this.#commitObservation(record, raw);
  }

  async #replayOrConflict(record, request, allowEnsure) {
    const replay = classifyAcceleratorBrokerExecuteReplay(record.request, request);
    if (!replay.sameRequestScope || replay.conflict || !replay.replay) {
      return rejectedObservation(request, digestAcceleratorBrokerExecuteRequest(request), ACCELERATOR_BROKER_REASON.REQUEST_CONFLICT);
    }
    if (isAcceleratorBrokerTerminalState(record.observation.state)) return record.observation;
    if (!allowEnsure) return (await this.#observeBackend(record)).observation;
    const reconciled = record.cancelIntent
      ? await this.#ensureCancellation(record)
      : await this.#ensureExecution(record);
    return reconciled.observation;
  }

  async execute(rawRequest) {
    const request = normalizeAcceleratorBrokerExecuteRequest(rawRequest);
    const requestDigest = digestAcceleratorBrokerExecuteRequest(request);
    const key = acceleratorBrokerLedgerKey(request);
    const existing = await this.#load(key);
    if (existing) return this.#replayOrConflict(existing, request, true);

    const currentBinding = await this.#currentBinding(request);
    if (currentBinding == null) {
      return this.#createTerminal(request, requestDigest, ACCELERATOR_BROKER_REASON.BACKEND_UNAVAILABLE);
    }
    if (currentBinding === false) {
      return this.#createTerminal(request, requestDigest, ACCELERATOR_BROKER_REASON.BINDING_STALE);
    }

    const accepted = observationFor(request, requestDigest, ACCELERATOR_BROKER_STATE.ACCEPTED);
    const record = createAcceleratorBrokerLedgerRecord({ request, observation: accepted });
    if (await this.#ledger.create(key, record) !== true) {
      const raced = await this.#load(key);
      if (!raced) throw new Error('accelerator broker ledger create outcome is ambiguous');
      return this.#replayOrConflict(raced, request, true);
    }
    return (await this.#ensureExecution(record)).observation;
  }

  async observe(rawRequest) {
    const request = normalizeAcceleratorBrokerExecuteRequest(rawRequest);
    const record = await this.#load(acceleratorBrokerLedgerKey(request));
    if (!record) return null;
    return this.#replayOrConflict(record, request, false);
  }

  async cancel(rawCancel) {
    const cancel = normalizeAcceleratorBrokerCancelRequest(rawCancel);
    const key = acceleratorBrokerCancelLedgerKey(cancel);
    let record = await this.#load(key);
    if (!record) return null;
    if (cancel.executionId !== record.request.executionId
      || cancel.requestDigest !== record.requestDigest
      || !same(cancel.binding, record.request.binding)) return null;
    if (isAcceleratorBrokerTerminalState(record.observation.state)) return record.observation;

    const cancelDigest = digestAcceleratorBrokerCancelRequest(cancel);
    if (record.cancelIntent) {
      if (record.cancelIntent.request.cancelId !== cancel.cancelId || record.cancelIntent.digest !== cancelDigest) {
        throw new Error('accelerator broker cancellation conflicts with active cancellation intent');
      }
      return (await this.#ensureCancellation(record)).observation;
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      let next;
      try {
        next = advanceAcceleratorBrokerLedgerRecord(record, { cancel });
      } catch {
        throw new Error('accelerator broker cancellation intent is invalid');
      }
      if (await this.#ledger.compareAndSwap(key, record.revision, next) === true) {
        return (await this.#ensureCancellation(next)).observation;
      }
      record = await this.#load(key);
      if (!record) throw new Error('accelerator broker ledger disappeared during cancellation');
      if (isAcceleratorBrokerTerminalState(record.observation.state)) return record.observation;
      if (record.cancelIntent) {
        if (record.cancelIntent.request.cancelId !== cancel.cancelId || record.cancelIntent.digest !== cancelDigest) {
          throw new Error('accelerator broker cancellation conflicts with active cancellation intent');
        }
        return (await this.#ensureCancellation(record)).observation;
      }
    }
    throw new Error('accelerator broker cancellation intent did not converge');
  }
}
