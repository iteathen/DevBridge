import {
  ENVIRONMENT_RECONSTRUCTABILITY,
  logicalEnvironmentIdentity,
  normalizeEnvironmentDeclaration,
} from './environment-declaration.js';
import {
  environmentObservationCondition,
  normalizeEnvironmentObservation,
} from './environment-observation.js';

export const ENVIRONMENT_DIAGNOSIS_PROTOCOL = 'devbridge/environment-diagnosis-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const STATES = new Set(['ready', 'degraded', 'blocked', 'absent', 'ambiguous']);
const ACTIONS = new Set(['none', 'create', 'start', 'repair', 'rebuild', 'reset', 'recreate', 'setup-reentry', 'provider-action-required', 'manual-review']);
const OWNERSHIP = new Set(['verified', 'foreign', 'ambiguous']);
const RESOURCE = new Set(['ready', 'blocked', 'unknown']);
const NETWORK = new Set(['ready', 'degraded', 'unknown']);
const WORKSPACES = new Set(['ready', 'degraded', 'unknown']);
const EXECUTION = new Set(['unknown', 'running', 'stopped', 'paused', 'saved']);
const ACTIVE = new Set(['none', 'repair', 'other', 'ambiguous']);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
function member(value, allowed, name) {
  if (!allowed.has(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
function declarationRecord(raw) {
  const value = requireObject(raw, 'environment diagnosis declaration record');
  const declaration = normalizeEnvironmentDeclaration(value.declaration);
  const identity = logicalEnvironmentIdentity(declaration.profile);
  if (value.identity !== identity) throw new TypeError('environment diagnosis declaration identity does not match declaration');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new TypeError('environment diagnosis declaration revision is invalid');
  return Object.freeze({ identity, revision: value.revision, declaration });
}
function impact({ destructive = false, unavailable = [], reseedable = [] } = {}) {
  return Object.freeze({
    destructive,
    preserves: Object.freeze(['logical-environment', 'desired-declaration']),
    unavailable: Object.freeze(unavailable.map((value) => safeId(value, 'environment diagnosis unavailable state'))),
    reseedable: Object.freeze(reseedable.map((value) => safeId(value, 'environment diagnosis reseedable state'))),
  });
}
function diagnosis(record, { state, cause, repairableInPlace, supportedNextAction, explanation, impact: resultImpact }) {
  member(state, STATES, 'environment diagnosis state');
  member(supportedNextAction, ACTIONS, 'environment diagnosis supportedNextAction');
  if (typeof repairableInPlace !== 'boolean') throw new TypeError('environment diagnosis repairableInPlace is invalid');
  if (typeof explanation !== 'string' || explanation.length === 0 || explanation.length > 2048) throw new TypeError('environment diagnosis explanation is invalid');
  return Object.freeze({
    protocol: ENVIRONMENT_DIAGNOSIS_PROTOCOL,
    environmentIdentity: record?.identity ?? null,
    declarationRevision: record?.revision ?? null,
    state,
    cause: safeId(cause, 'environment diagnosis cause'),
    repairableInPlace,
    supportedNextAction,
    explanation,
    impact: resultImpact ?? impact(),
  });
}

export function diagnoseEnvironment({
  declaration = null,
  observation = null,
  reconstructability = ENVIRONMENT_RECONSTRUCTABILITY.READY,
  ownership = 'verified',
  resources = 'ready',
  network = 'ready',
  workspaces = 'ready',
  execution = 'unknown',
  activeTransition = 'none',
} = {}) {
  member(ownership, OWNERSHIP, 'environment diagnosis ownership');
  member(resources, RESOURCE, 'environment diagnosis resources');
  member(network, NETWORK, 'environment diagnosis network');
  member(workspaces, WORKSPACES, 'environment diagnosis workspaces');
  member(execution, EXECUTION, 'environment diagnosis execution');
  member(activeTransition, ACTIVE, 'environment diagnosis activeTransition');

  if (declaration == null) {
    return diagnosis(null, {
      state: 'blocked', cause: 'declaration-missing', repairableInPlace: false, supportedNextAction: 'setup-reentry',
      explanation: 'No complete local environment declaration is available; setup re-entry is required before lifecycle mutation.',
    });
  }
  const record = declarationRecord(declaration);

  if (reconstructability === ENVIRONMENT_RECONSTRUCTABILITY.SETUP || reconstructability === ENVIRONMENT_RECONSTRUCTABILITY.DISCOVERY) {
    return diagnosis(record, {
      state: 'blocked', cause: 'declaration-incomplete', repairableInPlace: false, supportedNextAction: 'setup-reentry',
      explanation: 'The environment declaration requires local discovery or setup re-entry before safe lifecycle mutation.',
    });
  }
  if (reconstructability === ENVIRONMENT_RECONSTRUCTABILITY.UNSAFE || ownership !== 'verified') {
    return diagnosis(record, {
      state: 'ambiguous', cause: ownership === 'foreign' ? 'foreign-provider-collision' : 'authority-ambiguous',
      repairableInPlace: false, supportedNextAction: 'manual-review',
      explanation: 'Provider ownership or reconstruction authority is not exact enough for automatic mutation.',
    });
  }
  if (reconstructability !== ENVIRONMENT_RECONSTRUCTABILITY.READY) throw new TypeError('environment diagnosis reconstructability is invalid');

  if (activeTransition === 'ambiguous' || activeTransition === 'other') {
    return diagnosis(record, {
      state: 'ambiguous', cause: 'lifecycle-transition-incomplete', repairableInPlace: false, supportedNextAction: 'manual-review',
      explanation: 'Another or ambiguous lifecycle transition must be reconciled before a new repair is authorized.',
    });
  }
  if (activeTransition === 'repair') {
    return diagnosis(record, {
      state: 'degraded', cause: 'lifecycle-transition-incomplete', repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'An interrupted repair transition is active and may be resumed through the same repair lifecycle.',
    });
  }

  const observed = normalizeEnvironmentObservation(observation);
  if (observed.environmentIdentity !== record.identity || observed.declarationRevision !== record.revision) {
    return diagnosis(record, {
      state: 'ambiguous', cause: 'observation-stale', repairableInPlace: false, supportedNextAction: 'manual-review',
      explanation: 'The current observation is not bound to the active declaration revision.',
    });
  }

  const condition = environmentObservationCondition(observed);
  if (condition === 'transition-ambiguous' || condition === 'materialization-ambiguous') {
    return diagnosis(record, {
      state: 'ambiguous', cause: condition, repairableInPlace: false, supportedNextAction: 'manual-review',
      explanation: 'Observed lifecycle or provider state is ambiguous and cannot authorize automatic mutation.',
    });
  }
  if (condition === 'transition-incomplete') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'An exact interrupted lifecycle effect can be reconciled in place through bounded repair.',
    });
  }
  if (condition === 'materialization-unobservable') {
    return diagnosis(record, {
      state: 'blocked', cause: 'provider-unavailable', repairableInPlace: false, supportedNextAction: 'provider-action-required',
      explanation: 'The environment provider cannot currently be observed; no mutation is safe until provider visibility returns.',
    });
  }
  if (condition === 'materialization-not-created') {
    return diagnosis(record, {
      state: 'absent', cause: condition, repairableInPlace: false, supportedNextAction: 'create',
      explanation: 'No provider materialization exists for this declaration; use create rather than repair.',
    });
  }
  if (condition === 'materialization-missing') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: false, supportedNextAction: 'recreate',
      explanation: 'The provider implementation is missing; bounded in-place repair cannot assume provider reconstruction semantics.',
      impact: impact({ destructive: true, unavailable: ['current-materialization'], reseedable: ['workspace-source'] }),
    });
  }
  if (condition === 'system-storage-missing') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: false, supportedNextAction: 'rebuild',
      explanation: 'Guest system storage is missing. The saved declaration can reconstruct the environment; repair cannot restore a nonexistent system disk.',
      impact: impact({ destructive: true, unavailable: ['guest-mutable-state'], reseedable: ['workspace-source'] }),
    });
  }
  if (condition === 'system-storage-invalid') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: false, supportedNextAction: 'rebuild',
      explanation: 'Guest system storage lineage or integrity is invalid; repair will not reparent, rebase, or silently reuse it.',
      impact: impact({ destructive: true, unavailable: ['trusted-system-baseline'], reseedable: ['workspace-source'] }),
    });
  }
  if (condition === 'attachment-invalid') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'Exact owned storage is present but its attachment/configuration is invalid and may be reconciled without replacing the guest baseline.',
    });
  }
  if (resources === 'blocked') {
    return diagnosis(record, {
      state: 'blocked', cause: 'resource-admission-failed', repairableInPlace: false, supportedNextAction: 'provider-action-required',
      explanation: 'Required host resources are not currently admissible; lifecycle mutation is blocked before provider effects.',
    });
  }
  if (network === 'degraded') {
    return diagnosis(record, {
      state: 'degraded', cause: 'network-degraded', repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'The declared network requirement is degraded and may be reconciled without replacing guest system storage.',
    });
  }
  if (condition === 'enrollment-missing' || condition === 'enrollment-stale') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'Guest enrollment/trust evidence is incomplete and may be re-established against the exact current implementation.',
    });
  }
  if (condition === 'bootstrap-degraded') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'The declared bootstrap/tooling generation is degraded and may be idempotently reconciled in place.',
    });
  }
  if (workspaces === 'degraded') {
    return diagnosis(record, {
      state: 'degraded', cause: 'workspace-degraded', repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'Registered workspace readiness is degraded and may be reseeded from host-authoritative source without replacing the guest baseline.',
    });
  }
  if ((execution === 'stopped' || execution === 'paused' || execution === 'saved') && (condition === 'healthy' || condition === 'guest-unreachable')) {
    return diagnosis(record, {
      state: 'degraded', cause: 'materialization-not-running', repairableInPlace: false, supportedNextAction: 'start',
      explanation: 'The exact materialization is not running; use the bounded start lifecycle rather than repair.',
    });
  }
  if (condition === 'guest-unreachable') {
    return diagnosis(record, {
      state: 'blocked', cause: condition, repairableInPlace: false, supportedNextAction: 'provider-action-required',
      explanation: 'The guest is unreachable while provider state is otherwise present; provider or connectivity diagnosis is required before mutation.',
    });
  }
  if (condition === 'guest-degraded') {
    return diagnosis(record, {
      state: 'degraded', cause: condition, repairableInPlace: true, supportedNextAction: 'repair',
      explanation: 'Guest readiness is degraded without evidence that system storage must be replaced; bounded preparation/workspace repair is available.',
    });
  }
  if (condition === 'incomplete-observation' || resources === 'unknown' || network === 'unknown' || workspaces === 'unknown') {
    return diagnosis(record, {
      state: 'ambiguous', cause: 'observation-incomplete', repairableInPlace: false, supportedNextAction: 'manual-review',
      explanation: 'Current evidence is incomplete and cannot authorize a repair effect.',
    });
  }
  if (condition !== 'healthy') throw new Error(`environment diagnosis does not classify observation condition: ${condition}`);
  return diagnosis(record, {
    state: 'ready', cause: 'healthy', repairableInPlace: false, supportedNextAction: 'none',
    explanation: 'The environment matches its declaration and is ready.',
  });
}

function activeKind(record) {
  if (record == null || record.entries?.at(-1)?.stage === 'terminal') return 'none';
  if (record.operation === 'repair') return 'repair';
  return 'other';
}

export class EnvironmentDiagnosisService {
  #declarations; #journal; #observer; #evidence;
  constructor({ declarations, journal = null, observer, evidence = null } = {}) {
    if (!declarations || typeof declarations.get !== 'function' || typeof declarations.list !== 'function') throw new TypeError('environment diagnosis declaration contract is incomplete');
    if (journal != null && typeof journal.current !== 'function') throw new TypeError('environment diagnosis journal contract is incomplete');
    if (!observer || typeof observer.observe !== 'function') throw new TypeError('environment diagnosis observation contract is incomplete');
    if (evidence != null && typeof evidence.inspect !== 'function') throw new TypeError('environment diagnosis evidence contract is incomplete');
    this.#declarations = declarations; this.#journal = journal; this.#observer = observer; this.#evidence = evidence;
  }
  async #forRecord(record) {
    const observation = await this.#observer.observe(Object.freeze({
      environmentIdentity: record.identity,
      declarationRevision: record.revision,
      declaration: record.declaration,
    }));
    const extra = this.#evidence ? await this.#evidence.inspect(Object.freeze({ record, observation })) : {};
    const current = this.#journal ? await this.#journal.current(record.identity) : null;
    return diagnoseEnvironment({ declaration: record, observation, activeTransition: activeKind(current), ...extra });
  }
  async diagnose(identity) {
    const selected = safeId(identity, 'environment identity');
    const record = await this.#declarations.get(selected);
    if (!record) return diagnoseEnvironment({ declaration: null });
    return this.#forRecord(record);
  }
  async list() {
    const records = await this.#declarations.list();
    return Object.freeze(await Promise.all(records.map((record) => this.#forRecord(record))));
  }
}
