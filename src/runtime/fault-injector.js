import { PatchPollerError, PolicyError } from '../errors.js';

const POINTS = new Set([
  'file.after-effect',
  'operation.before',
  'operation.after-effect',
  'process.after-exit',
  'cleanup.before-remove',
  'scratch.cleanup.before-remove',
]);
const ACTIONS = new Set(['error', 'crash', 'interrupt', 'timeout', 'truncate-output']);

export class FaultInjectionError extends PatchPollerError {
  constructor(message, { point, action, ruleId } = {}) {
    super(message);
    this.point = point;
    this.action = action;
    this.ruleId = ruleId;
    this.simulatedCrash = action === 'crash';
    this.postEffectInterruption = action === 'interrupt';
  }
}

function safeRule(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError(`faultInjection.rules[${index}] must be an object`);
  const id = raw.id ?? `rule-${index + 1}`;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/u.test(id)) throw new PolicyError(`faultInjection.rules[${index}].id is invalid`);
  if (!POINTS.has(raw.point)) throw new PolicyError(`faultInjection.rules[${index}].point is unsupported`);
  if (!ACTIONS.has(raw.action)) throw new PolicyError(`faultInjection.rules[${index}].action is unsupported`);
  const occurrence = raw.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > 1000) throw new PolicyError(`faultInjection.rules[${index}].occurrence is invalid`);
  const operation = raw.operation ?? null;
  if (operation != null && (typeof operation !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/u.test(operation))) {
    throw new PolicyError(`faultInjection.rules[${index}].operation is invalid`);
  }
  return { id, point: raw.point, action: raw.action, occurrence, operation };
}

export function validateFaultInjectionConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError('execution.faultInjection must be an object');
  const rules = raw.rules ?? [];
  if (!Array.isArray(rules) || rules.length > 32) throw new PolicyError('execution.faultInjection.rules must contain at most 32 local rules');
  return { enabled: raw.enabled === true, rules: rules.map(safeRule) };
}

export class DeterministicFaultInjector {
  #config;
  #seen = new Map();

  constructor(config = {}) {
    this.#config = validateFaultInjectionConfig(config);
  }

  get enabled() { return this.#config.enabled; }

  inspect() {
    return {
      enabled: this.#config.enabled,
      ruleCount: this.#config.rules.length,
      points: [...POINTS].sort(),
      actions: [...ACTIONS].sort(),
    };
  }

  trigger(point, context = {}) {
    if (!this.#config.enabled) return null;
    for (const rule of this.#config.rules) {
      if (rule.point !== point) continue;
      if (rule.operation && rule.operation !== context.operation) continue;
      const key = `${rule.id}:${point}:${rule.operation ?? '*'}`;
      const count = (this.#seen.get(key) ?? 0) + 1;
      this.#seen.set(key, count);
      if (count === rule.occurrence) return { ...rule, point, context: { operation: context.operation ?? null } };
    }
    return null;
  }

  throwIfTriggered(point, context = {}) {
    const fault = this.trigger(point, context);
    if (!fault) return null;
    if (['error', 'crash', 'interrupt'].includes(fault.action)) {
      throw new FaultInjectionError(`locally configured deterministic fault ${fault.id} injected at ${point}`, fault);
    }
    return fault;
  }
}
