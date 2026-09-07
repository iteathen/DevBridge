import { createHash } from 'node:crypto';
import { environmentDeclarationDigest } from '../runtime/environment-declaration.js';

export const ENVIRONMENT_OPERATOR_PROTOCOL = 'devbridge/environment-operator-v1';
export const ENVIRONMENT_OPERATOR_STATUS_PROTOCOL = 'devbridge/environment-operator-status-v1';
export const ENVIRONMENT_OPERATOR_PLAN_PROTOCOL = 'devbridge/environment-operator-plan-v1';
export const ENVIRONMENT_SETUP_REENTRY_PROTOCOL = 'devbridge/environment-setup-reentry-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const OPERATIONS = new Set(['create', 'repair', 'rebuild', 'reset', 'recreate']);
const DESTRUCTIVE = new Set(['rebuild', 'reset', 'recreate']);

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
function assertMethod(value, name) {
  if (typeof value !== 'function') throw new TypeError(`environment operator ${name} contract is incomplete`);
  return value;
}
function active(record) {
  return record != null && record.entries?.at(-1)?.stage !== 'terminal';
}
function stage(record) {
  return record?.entries?.at(-1)?.stage ?? null;
}
function workspaceIdentities(record) {
  return Object.freeze(record.declaration.workspaces.map((workspace) => workspace.identity));
}
function warning(operation) {
  if (operation === 'rebuild') return 'Rebuild replaces missing or invalid guest system storage and discards guest-local mutable state that is not declared as protected.';
  if (operation === 'reset') return 'Reset replaces the current guest baseline and discards guest-local mutable state, dependencies, build products, cache, scratch, and workspace materialization.';
  if (operation === 'recreate') return 'Recreate replaces the provider instance and its guest-local state; the old generation is retired only after the replacement verifies ready.';
  return null;
}
function authorizationSubject(operation, impact) {
  if (typeof impact?.authorizationSubject === 'string' && impact.authorizationSubject.length > 0) return impact.authorizationSubject;
  const digest = createHash('sha256').update(JSON.stringify(impact), 'utf8').digest('hex');
  return `${operation}-${digest}`;
}
function ownerMethod(runtime, operation, prefix = '') {
  const name = prefix
    ? `${prefix}${operation[0].toUpperCase()}${operation.slice(1)}`
    : operation;
  return assertMethod(runtime[name], name).bind(runtime);
}
function neutralObservation(observation) {
  if (!observation) return null;
  return Object.freeze({
    implementationGeneration: observation.implementationGeneration ?? null,
    materialization: observation.materialization ?? 'unavailable',
    systemStorage: observation.systemStorage ?? 'unknown',
    attachment: observation.attachment ?? 'unknown',
    enrollment: observation.enrollment ?? 'unknown',
    bootstrap: observation.bootstrap ?? 'unknown',
    guest: observation.guest ?? 'unknown',
    transition: observation.transition ?? 'ambiguous',
  });
}
function neutralImageRecovery(raw, declaration) {
  const identity = declaration.image.identity;
  const generation = declaration.image.generation;
  if (!raw || typeof raw !== 'object') {
    return Object.freeze({
      identity,
      generation,
      state: 'unknown',
      localVerified: false,
      reacquirable: null,
      blocker: 'availability-inspection-unavailable',
    });
  }
  return Object.freeze({
    identity,
    generation,
    state: String(raw.state ?? 'unknown').slice(0, 80),
    localVerified: raw.localVerified === true,
    reacquirable: raw.reacquirable === true ? true : raw.reacquirable === false ? false : null,
    blocker: raw.blocker == null ? null : String(raw.blocker).slice(0, 160),
  });
}
function genericImpact(record, observation, operation, lifecycleRecord) {
  const workspaces = workspaceIdentities(record);
  const isCreate = operation === 'create';
  const isRepair = operation === 'repair';
  return Object.freeze({
    protocol: ENVIRONMENT_OPERATOR_PLAN_PROTOCOL,
    operation,
    destructive: false,
    environmentIdentity: record.identity,
    declarationRevision: record.revision,
    currentImplementationGeneration: observation?.implementationGeneration ?? null,
    proposedImplementationGeneration: isCreate ? null : observation?.implementationGeneration ?? null,
    implementationGenerationChanges: isCreate,
    affectedWorkspaces: workspaces,
    preserves: Object.freeze(['logical-environment', 'desired-declaration', 'workspace-authority']),
    discards: Object.freeze([]),
    blocked: active(lifecycleRecord) && lifecycleRecord.operation !== operation,
    blockers: Object.freeze(active(lifecycleRecord) && lifecycleRecord.operation !== operation ? ['another-lifecycle-operation-active'] : []),
    resumable: active(lifecycleRecord) && lifecycleRecord.operation === operation,
    note: isRepair
      ? 'Repair reconciles the exact current implementation in place and does not change its implementation generation.'
      : 'Create materializes the saved desired declaration without adopting unrelated provider state.',
  });
}

export function createEnvironmentOperator({ runtime } = {}) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('environment operator runtime contract is incomplete');
  const declarations = runtime.lifecycle?.declarations;
  const journal = runtime.lifecycle?.journal;
  if (!declarations || typeof declarations.list !== 'function' || typeof declarations.get !== 'function') throw new TypeError('environment operator declaration contract is incomplete');
  if (!journal || typeof journal.current !== 'function' || typeof journal.active !== 'function') throw new TypeError('environment operator journal contract is incomplete');
  if (!runtime.observer || typeof runtime.observer.observe !== 'function') throw new TypeError('environment operator observation contract is incomplete');
  assertMethod(runtime.diagnose, 'diagnose');

  const statusForRecord = async (record) => {
    const lifecycleRecord = await journal.current(record.identity);
    let observation = null;
    let diagnosis = null;
    try {
      observation = await runtime.observer.observe(Object.freeze({
        environmentIdentity: record.identity,
        declarationRevision: record.revision,
        declaration: record.declaration,
      }));
      diagnosis = await runtime.diagnose(record.identity);
    } catch {
      diagnosis = Object.freeze({
        state: 'blocked',
        cause: 'observation-unavailable',
        repairableInPlace: false,
        supportedNextAction: 'provider-action-required',
        explanation: 'Environment state could not be observed through the bounded provider interface; no lifecycle mutation is authorized from this diagnostic result.',
        impact: Object.freeze({ destructive: false, preserves: Object.freeze(['logical-environment', 'desired-declaration']), unavailable: Object.freeze([]), reseedable: Object.freeze([]) }),
      });
    }

    let imageRecovery;
    try {
      imageRecovery = runtime.availability?.inspect
        ? neutralImageRecovery(await runtime.availability.inspect({
            identity: record.declaration.image.identity,
            generation: record.declaration.image.generation,
          }), record.declaration)
        : neutralImageRecovery(null, record.declaration);
    } catch {
      imageRecovery = neutralImageRecovery({
        state: 'unavailable',
        localVerified: false,
        reacquirable: false,
        blocker: 'approved-image-source-unavailable',
      }, record.declaration);
    }

    const interrupted = active(lifecycleRecord);
    const lastStage = stage(lifecycleRecord);
    return Object.freeze({
      protocol: ENVIRONMENT_OPERATOR_STATUS_PROTOCOL,
      environmentIdentity: record.identity,
      profile: record.declaration.profile,
      declarationRevision: record.revision,
      declarationDigest: environmentDeclarationDigest(record.declaration),
      reconstructability: 'fully-reconstructable',
      desiredGeneration: Object.freeze({
        schema: record.declaration.schemaGeneration,
        guest: record.declaration.guest.generation,
        image: record.declaration.image.generation,
        bootstrap: record.declaration.bootstrap.generation,
      }),
      observed: neutralObservation(observation),
      imageRecovery,
      health: Object.freeze({
        state: diagnosis.state,
        cause: diagnosis.cause,
        repairableInPlace: diagnosis.repairableInPlace,
        explanation: diagnosis.explanation,
      }),
      impact: diagnosis.impact,
      lifecycle: interrupted
        ? Object.freeze({
            active: true,
            resumable: true,
            operation: lifecycleRecord.operation,
            operationId: lifecycleRecord.operationId,
            stage: lastStage,
            updatedAt: lifecycleRecord.entries.at(-1)?.at ?? null,
          })
        : Object.freeze({ active: false, resumable: false, operation: null, operationId: null, stage: lastStage, updatedAt: lifecycleRecord?.entries?.at(-1)?.at ?? null }),
      recommendedAction: interrupted ? 'resume' : diagnosis.supportedNextAction,
      operatorCommandAvailable: interrupted || OPERATIONS.has(diagnosis.supportedNextAction),
    });
  };

  const getRecord = async (identity) => {
    const selected = safeId(identity, 'environment identity');
    const record = await declarations.get(selected);
    if (!record) return null;
    return record;
  };

  const plan = async (rawOperation, rawIdentity) => {
    const operation = String(rawOperation ?? '');
    if (!OPERATIONS.has(operation)) throw new TypeError('environment lifecycle operation is invalid');
    const identity = safeId(rawIdentity, 'environment identity');
    const record = await getRecord(identity);
    if (!record) throw new Error('environment declaration is unavailable; setup re-entry is required');
    const lifecycleRecord = await journal.current(identity);
    if (active(lifecycleRecord) && lifecycleRecord.operation !== operation) throw new Error('another lifecycle operation is active for the environment');

    if (!DESTRUCTIVE.has(operation)) {
      let observation = null;
      try {
        observation = await runtime.observer.observe(Object.freeze({
          environmentIdentity: record.identity,
          declarationRevision: record.revision,
          declaration: record.declaration,
        }));
      } catch {}
      return genericImpact(record, observation, operation, lifecycleRecord);
    }

    const owned = await ownerMethod(runtime, operation, 'plan')(identity);
    const subject = authorizationSubject(operation, owned);
    return Object.freeze({
      ...owned,
      operation,
      destructive: true,
      authorizationSubject: subject,
      warning: warning(operation),
      confirmation: Object.freeze({
        required: true,
        authorizationSubject: subject,
        instruction: `Re-run the ${operation} command with --confirm ${subject}`,
      }),
    });
  };

  const invoke = async (operation, identity, approval = null) => {
    if (operation === 'reset' || operation === 'recreate') return ownerMethod(runtime, operation)(identity, { approval });
    return ownerMethod(runtime, operation)(identity);
  };

  const list = async () => {
    const records = await declarations.list();
    return Object.freeze(await Promise.all(records.map((record) => statusForRecord(record))));
  };

  const status = async (rawIdentity) => {
    const identity = safeId(rawIdentity, 'environment identity');
    const record = await getRecord(identity);
    if (!record) {
      const diagnosis = await runtime.diagnose(identity);
      return Object.freeze({
        protocol: ENVIRONMENT_OPERATOR_STATUS_PROTOCOL,
        environmentIdentity: identity,
        profile: null,
        declarationRevision: null,
        reconstructability: 'setup-reentry-required',
        desiredGeneration: null,
        observed: null,
        imageRecovery: null,
        health: Object.freeze({
          state: diagnosis.state,
          cause: diagnosis.cause,
          repairableInPlace: diagnosis.repairableInPlace,
          explanation: diagnosis.explanation,
        }),
        impact: diagnosis.impact,
        lifecycle: Object.freeze({ active: false, resumable: false, operation: null, operationId: null, stage: null, updatedAt: null }),
        recommendedAction: 'setup-reentry',
        operatorCommandAvailable: true,
      });
    }
    return statusForRecord(record);
  };

  const run = async (rawOperation, rawIdentity, { approval = null } = {}) => {
    const operation = String(rawOperation ?? '');
    if (!OPERATIONS.has(operation)) throw new TypeError('environment lifecycle operation is invalid');
    const identity = safeId(rawIdentity, 'environment identity');
    const current = await journal.current(identity);
    if (active(current)) {
      if (current.operation !== operation) throw new Error('another lifecycle operation is active for the environment');
      if (DESTRUCTIVE.has(operation) && stage(current) === 'intent') {
        const impact = await plan(operation, identity);
        if (approval !== impact.authorizationSubject) throw new Error(`exact destructive confirmation is required: ${impact.authorizationSubject}`);
      }
      return invoke(operation, identity, approval);
    }

    if (DESTRUCTIVE.has(operation)) {
      const impact = await plan(operation, identity);
      if (impact.blocked === true || (Array.isArray(impact.blockers) && impact.blockers.length > 0)) {
        throw new Error(`environment ${operation} is blocked by the current impact plan`);
      }
      if (approval !== impact.authorizationSubject) throw new Error(`exact destructive confirmation is required: ${impact.authorizationSubject}`);
    }
    return invoke(operation, identity, approval);
  };

  const setupReentry = async (rawIdentity = null) => {
    const identity = rawIdentity == null ? null : safeId(rawIdentity, 'environment identity');
    const current = identity == null ? null : await journal.current(identity);
    const selectedStatus = identity == null ? null : await status(identity);
    return Object.freeze({
      protocol: ENVIRONMENT_SETUP_REENTRY_PROTOCOL,
      action: 'setup-reentry',
      environmentIdentity: identity,
      reason: selectedStatus?.health?.cause ?? 'local-configuration-authority-required',
      authority: Object.freeze({
        requiredCapability: 'local-environment-configuration-authority',
        remoteIssueTextMayAuthorize: false,
        remoteModelOutputMayAuthorize: false,
        providerMutationAllowed: false,
      }),
      owner: Object.freeze({ workflow: 'guided-setup-and-reconfiguration', trackingIssue: 116 }),
      interruptedLifecycle: active(current)
        ? Object.freeze({ operation: current.operation, operationId: current.operationId, stage: stage(current), resumable: true })
        : null,
      returnAction: active(current) ? 'environment resume' : 'environment list',
    });
  };

  return Object.freeze({
    protocol: ENVIRONMENT_OPERATOR_PROTOCOL,
    list,
    async inspect() {
      const environments = await list();
      const activeRecords = await journal.active();
      return Object.freeze({
        protocol: ENVIRONMENT_OPERATOR_PROTOCOL,
        state: environments.length === 0 ? 'setup-reentry-required' : activeRecords.length > 0 ? 'recovery-required' : 'ready',
        declarationCount: environments.length,
        activeTransitionCount: activeRecords.length,
        setupReentryRequired: environments.length === 0,
        nextAction: environments.length === 0 ? 'setup-reentry' : activeRecords.length > 0 ? 'resume' : 'none',
        environments,
      });
    },
    status,
    plan,
    run,
    async resume(rawIdentity, { approval = null } = {}) {
      const identity = safeId(rawIdentity, 'environment identity');
      const current = await journal.current(identity);
      if (!active(current)) {
        return Object.freeze({ state: 'no-active-transition', environmentIdentity: identity });
      }
      if (!OPERATIONS.has(current.operation)) throw new Error('active lifecycle operation is unsupported by this operator');
      return run(current.operation, identity, { approval });
    },
    setupReentry,
  });
}
