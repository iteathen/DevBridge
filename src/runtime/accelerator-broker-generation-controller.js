import {
  ACCELERATOR_BROKER_REASON,
  ACCELERATOR_BROKER_STATE,
  createAcceleratorBrokerObservation,
  digestAcceleratorBrokerExecuteRequest,
  normalizeAcceleratorBrokerCancelRequest,
  normalizeAcceleratorBrokerExecuteRequest,
} from './accelerator-broker-protocol.js';
import {
  ACCELERATOR_BROKER_GENERATION_PHASE,
  acceleratorBrokerGenerationStateKey,
  beginAcceleratorBrokerGenerationRetirement,
  createAcceleratorBrokerGenerationStateRecord,
  normalizeAcceleratorBrokerGenerationStateRecord,
  promoteAcceleratorBrokerGeneration,
} from './accelerator-broker-generation-state.js';
import { normalizeAcceleratorBrokerGenerationObservation } from './accelerator-broker-generation-catalog.js';

export const ACCELERATOR_BROKER_GENERATION_RETIRE_PROTOCOL = 'devbridge/accelerator-broker-generation-retire-v1';
export const ACCELERATOR_BROKER_GENERATION_RETIREMENT_OBSERVATION_PROTOCOL = 'devbridge/accelerator-broker-generation-retirement-observation-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_STATE_ATTEMPTS = 8;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function assertPort(value, methods, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`accelerator broker generation controller ${name} contract is incomplete`);
  }
  return value;
}

function retirementRequest(raw) {
  const value = requireObject(raw, 'accelerator broker generation retirement request');
  onlyKeys(value, new Set([
    'protocol', 'operationId', 'sessionIdentity', 'retiringGeneration', 'nextGeneration',
  ]), 'accelerator broker generation retirement request');
  if (value.protocol !== ACCELERATOR_BROKER_GENERATION_RETIRE_PROTOCOL) {
    throw new TypeError('accelerator broker generation retirement protocol is unsupported');
  }
  const selected = Object.freeze({
    protocol: ACCELERATOR_BROKER_GENERATION_RETIRE_PROTOCOL,
    operationId: safeId(value.operationId, 'accelerator broker generation retirement operationId'),
    sessionIdentity: safeId(value.sessionIdentity, 'accelerator broker generation retirement sessionIdentity'),
    retiringGeneration: safeId(value.retiringGeneration, 'accelerator broker generation retirement retiringGeneration'),
    nextGeneration: safeId(value.nextGeneration, 'accelerator broker generation retirement nextGeneration'),
  });
  if (selected.retiringGeneration === selected.nextGeneration) {
    throw new TypeError('accelerator broker generation retirement generations must differ');
  }
  return selected;
}

function retirementObservation(input, { status, currentGeneration, quiescence = null, replayed = false } = {}) {
  if (!['blocked', 'promoted'].includes(status)) throw new TypeError('accelerator broker generation retirement status is invalid');
  const observation = quiescence == null ? null : normalizeAcceleratorBrokerGenerationObservation(quiescence);
  if (observation && (observation.session.identity !== input.sessionIdentity
      || observation.session.generation !== input.retiringGeneration)) {
    throw new TypeError('accelerator broker generation retirement quiescence belongs to another generation');
  }
  if (status === 'promoted' && currentGeneration !== input.nextGeneration) {
    throw new TypeError('accelerator broker generation retirement promoted generation is inconsistent');
  }
  if (status === 'blocked' && currentGeneration !== input.retiringGeneration) {
    throw new TypeError('accelerator broker generation retirement blocked generation is inconsistent');
  }
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_GENERATION_RETIREMENT_OBSERVATION_PROTOCOL,
    operationId: input.operationId,
    session: Object.freeze({
      identity: input.sessionIdentity,
      retiringGeneration: input.retiringGeneration,
      nextGeneration: input.nextGeneration,
      currentGeneration: safeId(currentGeneration, 'accelerator broker generation retirement currentGeneration'),
    }),
    status,
    replayed: replayed === true,
    quiescence: observation,
  });
}

function fencedExecuteObservation(request) {
  return createAcceleratorBrokerObservation({
    requestId: request.requestId,
    executionId: request.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(request),
    binding: request.binding,
    api: request.api,
    topology: request.topology,
    operation: request.operation,
    state: ACCELERATOR_BROKER_STATE.REJECTED,
    reason: ACCELERATOR_BROKER_REASON.BINDING_STALE,
    result: null,
  });
}

function samePromotion(record, input) {
  return record.phase === ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE
    && record.session.generation === input.nextGeneration
    && record.lastPromotion?.operationId === input.operationId
    && record.lastPromotion?.fromGeneration === input.retiringGeneration
    && record.lastPromotion?.toGeneration === input.nextGeneration;
}

function sameRetirement(record, input) {
  return record.phase === ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING
    && record.session.generation === input.retiringGeneration
    && record.retirement?.operationId === input.operationId
    && record.retirement?.nextGeneration === input.nextGeneration;
}

function acquiredLease(raw, expectedMode) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.release !== 'function') {
    throw new Error('accelerator broker generation admission evidence is invalid');
  }
  if (raw.mode != null && raw.mode !== expectedMode) throw new Error('accelerator broker generation admission mode changed');
  return raw;
}

export class AcceleratorBrokerGenerationController {
  #sessionIdentity;
  #initialGeneration;
  #core;
  #state;
  #catalog;
  #admission;

  constructor({ sessionIdentity, initialGeneration, core, state, catalog, admission } = {}) {
    this.#sessionIdentity = safeId(sessionIdentity, 'accelerator broker generation controller sessionIdentity');
    this.#initialGeneration = safeId(initialGeneration, 'accelerator broker generation controller initialGeneration');
    this.#core = assertPort(core, ['execute', 'observe', 'cancel'], 'core');
    this.#state = assertPort(state, ['load', 'create', 'compareAndSwap'], 'state');
    this.#catalog = assertPort(catalog, ['observeGeneration'], 'catalog');
    this.#admission = assertPort(admission, ['acquire'], 'admission');
  }

  #key() {
    return Object.freeze({ sessionIdentity: this.#sessionIdentity });
  }

  async #loadState() {
    const raw = await this.#state.load(this.#key());
    if (raw == null) return null;
    const record = normalizeAcceleratorBrokerGenerationStateRecord(raw);
    if (acceleratorBrokerGenerationStateKey(record).sessionIdentity !== this.#sessionIdentity) {
      throw new Error('accelerator broker generation state returned another session identity');
    }
    return record;
  }

  async #ensureState() {
    let current = await this.#loadState();
    if (current) return current;
    const initial = createAcceleratorBrokerGenerationStateRecord({
      sessionIdentity: this.#sessionIdentity,
      generation: this.#initialGeneration,
    });
    if (await this.#state.create(this.#key(), initial) === true) return initial;
    current = await this.#loadState();
    if (!current) throw new Error('accelerator broker generation state create outcome is ambiguous');
    return current;
  }

  async status() {
    return this.#ensureState();
  }

  async execute(rawRequest) {
    const request = normalizeAcceleratorBrokerExecuteRequest(rawRequest);
    if (request.binding.session.identity !== this.#sessionIdentity) return fencedExecuteObservation(request);
    const held = acquiredLease(await this.#admission.acquire(Object.freeze({ mode: 'shared' })), 'shared');
    try {
      const current = await this.#ensureState();
      if (current.phase !== ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE
        || request.binding.session.generation !== current.session.generation) {
        return fencedExecuteObservation(request);
      }
      return this.#core.execute(request);
    } finally {
      await held.release();
    }
  }

  async observe(rawRequest) {
    const request = normalizeAcceleratorBrokerExecuteRequest(rawRequest);
    if (request.binding.session.identity !== this.#sessionIdentity) return null;
    return this.#core.observe(request);
  }

  async cancel(rawCancel) {
    const cancel = normalizeAcceleratorBrokerCancelRequest(rawCancel);
    if (cancel.binding.session.identity !== this.#sessionIdentity) return null;
    return this.#core.cancel(cancel);
  }

  async #persistRetirement(current, input) {
    let selected = current;
    for (let attempt = 0; attempt < MAX_STATE_ATTEMPTS; attempt += 1) {
      if (sameRetirement(selected, input) || samePromotion(selected, input)) return selected;
      if (selected.phase !== ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE
        || selected.session.generation !== input.retiringGeneration) {
        throw new Error('accelerator broker generation retirement conflicts with current generation state');
      }
      const next = beginAcceleratorBrokerGenerationRetirement(selected, {
        operationId: input.operationId,
        nextGeneration: input.nextGeneration,
      });
      if (await this.#state.compareAndSwap(this.#key(), selected.revision, next) === true) return next;
      selected = await this.#loadState();
      if (!selected) throw new Error('accelerator broker generation state disappeared during retirement');
    }
    throw new Error('accelerator broker generation retirement did not converge');
  }

  async retire(rawRequest) {
    const input = retirementRequest(rawRequest);
    if (input.sessionIdentity !== this.#sessionIdentity) {
      throw new Error('accelerator broker generation retirement belongs to another session identity');
    }
    const held = acquiredLease(await this.#admission.acquire(Object.freeze({ mode: 'exclusive' })), 'exclusive');
    try {
      let current = await this.#ensureState();
      if (samePromotion(current, input)) {
        return retirementObservation(input, {
          status: 'promoted',
          currentGeneration: input.nextGeneration,
          replayed: true,
        });
      }
      current = await this.#persistRetirement(current, input);
      if (samePromotion(current, input)) {
        return retirementObservation(input, {
          status: 'promoted',
          currentGeneration: input.nextGeneration,
          replayed: true,
        });
      }
      if (!sameRetirement(current, input)) {
        throw new Error('accelerator broker generation retirement state is inconsistent');
      }

      const quiescence = normalizeAcceleratorBrokerGenerationObservation(await this.#catalog.observeGeneration(Object.freeze({
        sessionIdentity: input.sessionIdentity,
        sessionGeneration: input.retiringGeneration,
      })));
      if (quiescence.session.identity !== input.sessionIdentity
        || quiescence.session.generation !== input.retiringGeneration) {
        throw new Error('accelerator broker generation catalog returned another generation');
      }
      if (!quiescence.quiescent) {
        return retirementObservation(input, {
          status: 'blocked',
          currentGeneration: input.retiringGeneration,
          quiescence,
        });
      }

      const promoted = promoteAcceleratorBrokerGeneration(current, { operationId: input.operationId });
      if (await this.#state.compareAndSwap(this.#key(), current.revision, promoted) === true) {
        return retirementObservation(input, {
          status: 'promoted',
          currentGeneration: input.nextGeneration,
          quiescence,
        });
      }
      const raced = await this.#loadState();
      if (raced && samePromotion(raced, input)) {
        return retirementObservation(input, {
          status: 'promoted',
          currentGeneration: input.nextGeneration,
          quiescence,
          replayed: true,
        });
      }
      throw new Error('accelerator broker generation promotion did not converge exactly');
    } finally {
      await held.release();
    }
  }
}
