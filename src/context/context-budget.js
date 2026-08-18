import { ProtocolError } from '../errors.js';

const UNITS = new Set(['tokens', 'bytes', 'proxy']);
const DURABLE_CHECKPOINT_EVENTS = new Set([
  'candidate-sealed',
  'branch-published',
  'pr-mutated',
  'issue-mutated',
  'ci-terminal',
  'architecture-decision',
  'phase-transition',
  'before-large-evidence',
]);

function ratio(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ProtocolError(`${name} must be a finite ratio greater than 0 and less than 1`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError(`${name} must be a positive safe integer`);
  return value;
}

function sourceName(value) {
  if (value == null) return 'unspecified';
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/u.test(value)) {
    throw new ProtocolError('context budget observation source must be a safe bounded identifier');
  }
  return value;
}

function levelFor(ratioUsed, thresholds) {
  if (ratioUsed >= thresholds.hardRatio) return 'rollover-required';
  if (ratioUsed >= thresholds.preferredRatio) return 'rollover-preferred';
  if (ratioUsed >= thresholds.softRatio) return 'checkpoint';
  return 'normal';
}

export class ContextBudgetManager {
  #unit;
  #capacityUnits;
  #thresholds;
  #usedUnits = 0;
  #observations = 0;
  #lastObservation = null;

  constructor({
    unit = 'bytes',
    capacityUnits = 1_000_000,
    softRatio = 0.55,
    preferredRatio = 0.65,
    hardRatio = 0.75,
    initialUsedUnits = 0,
  } = {}) {
    if (!UNITS.has(unit)) throw new ProtocolError('context budget unit must be tokens, bytes, or proxy');
    this.#unit = unit;
    this.#capacityUnits = positiveInteger(capacityUnits, 'context budget capacityUnits');
    this.#thresholds = {
      softRatio: ratio(softRatio, 'context budget softRatio'),
      preferredRatio: ratio(preferredRatio, 'context budget preferredRatio'),
      hardRatio: ratio(hardRatio, 'context budget hardRatio'),
    };
    if (!(this.#thresholds.softRatio < this.#thresholds.preferredRatio &&
          this.#thresholds.preferredRatio < this.#thresholds.hardRatio)) {
      throw new ProtocolError('context budget ratios must satisfy softRatio < preferredRatio < hardRatio');
    }
    if (!Number.isSafeInteger(initialUsedUnits) || initialUsedUnits < 0) {
      throw new ProtocolError('context budget initialUsedUnits must be a non-negative safe integer');
    }
    this.#usedUnits = initialUsedUnits;
  }

  #amount(observation) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new ProtocolError('context budget observation must be an object');
    }
    const field = this.#unit === 'tokens' ? 'tokens' : this.#unit === 'bytes' ? 'bytes' : 'proxyUnits';
    const value = observation[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProtocolError(`context budget ${this.#unit} observation requires non-negative integer ${field}`);
    }
    return value;
  }

  observe(observation) {
    const amount = this.#amount(observation);
    const next = this.#usedUnits + amount;
    if (!Number.isSafeInteger(next)) throw new ProtocolError('context budget usage exceeds safe integer range');
    this.#usedUnits = next;
    this.#observations += 1;
    this.#lastObservation = {
      source: sourceName(observation.source),
      units: amount,
    };
    return this.snapshot();
  }

  reset({ usedUnits = 0 } = {}) {
    if (!Number.isSafeInteger(usedUnits) || usedUnits < 0) {
      throw new ProtocolError('context budget reset usedUnits must be a non-negative safe integer');
    }
    this.#usedUnits = usedUnits;
    this.#observations = 0;
    this.#lastObservation = null;
    return this.snapshot();
  }

  snapshot() {
    const ratioUsed = this.#usedUnits / this.#capacityUnits;
    const level = levelFor(ratioUsed, this.#thresholds);
    return {
      unit: this.#unit,
      capacityUnits: this.#capacityUnits,
      usedUnits: this.#usedUnits,
      remainingUnits: Math.max(0, this.#capacityUnits - this.#usedUnits),
      ratioUsed,
      level,
      checkpointRequested: level !== 'normal',
      rolloverPreferred: level === 'rollover-preferred' || level === 'rollover-required',
      rolloverRequired: level === 'rollover-required',
      observations: this.#observations,
      lastObservation: this.#lastObservation ? { ...this.#lastObservation } : null,
      thresholds: { ...this.#thresholds },
    };
  }
}

export function contextCheckpointPolicy(event, budgetSnapshot = null) {
  if (typeof event !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/u.test(event)) {
    throw new ProtocolError('checkpoint event must be a safe bounded identifier');
  }
  const durableBoundary = DURABLE_CHECKPOINT_EVENTS.has(event);
  const level = budgetSnapshot?.level ?? 'normal';
  if (!['normal', 'checkpoint', 'rollover-preferred', 'rollover-required'].includes(level)) {
    throw new ProtocolError('checkpoint policy received an invalid budget level');
  }
  return {
    event,
    durableBoundary,
    checkpoint: durableBoundary || level !== 'normal',
    rollover: level === 'rollover-required'
      ? 'required'
      : level === 'rollover-preferred'
        ? 'preferred'
        : 'none',
    reason: durableBoundary ? 'durable-boundary' : level,
  };
}

export { DURABLE_CHECKPOINT_EVENTS };
