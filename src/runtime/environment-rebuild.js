import { diagnoseEnvironment } from './environment-diagnosis.js';
import { normalizeEnvironmentObservation } from './environment-observation.js';

export const ENVIRONMENT_REBUILD_IMPACT_PROTOCOL = 'devbridge/environment-rebuild-impact-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const REBUILD_CAUSES = new Set(['system-storage-missing', 'system-storage-invalid']);
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function assertPort(value, methods, name) { if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`environment rebuild ${name} contract is incomplete`); return value; }
function active(record) { return record != null && record.entries?.at(-1)?.stage !== 'terminal'; }
function lastStage(record) { return record.entries.at(-1).stage; }
function fenceEntry(record) { return record.entries.find((entry) => entry.stage === 'fenced-attempt') ?? null; }
function preEntry(record) { return record.entries.find((entry) => entry.stage === 'pre-observation') ?? null; }
function causeEntry(record) { return preEntry(record)?.subjects?.[0] ?? null; }

function impactFor(record, observation, diagnosis) {
  const protectedState = Object.freeze([...record.declaration.protectedStateClasses]);
  const workspaces = Object.freeze(record.declaration.workspaces.map((workspace) => workspace.identity));
  const storage = diagnosis.cause === 'system-storage-missing' ? 'missing' : 'invalid';
  return Object.freeze({
    protocol: ENVIRONMENT_REBUILD_IMPACT_PROTOCOL,
    environmentIdentity: record.identity,
    declarationRevision: record.revision,
    currentImplementationGeneration: observation.implementationGeneration,
    systemStorage: storage,
    preserves: Object.freeze(['logical-environment', 'desired-declaration', 'workspace-authority']),
    reseeds: workspaces,
    unavailable: Object.freeze(storage === 'missing' ? ['guest-mutable-state'] : ['trusted-system-baseline']),
    discards: Object.freeze(['guest-dependencies', 'guest-build-products', 'guest-cache', 'guest-scratch']),
    protectedState,
    blocked: protectedState.length > 0,
    prerequisites: Object.freeze({
      profile: record.declaration.profile,
      imageIdentity: record.declaration.image.identity,
      imageGeneration: record.declaration.image.generation,
      bootstrapGeneration: record.declaration.bootstrap.generation,
      bootRequirement: record.declaration.boot.requirement,
      networkRequirement: record.declaration.network.requirement,
      memoryBytes: record.declaration.resources.memoryBytes,
      processorCount: record.declaration.resources.processorCount,
    }),
  });
}

export class EnvironmentRebuild {
  #declarations; #journal; #observer; #fence; #construction; #evidence;
  constructor({ declarations, journal, observer, fence, construction, evidence = null } = {}) {
    this.#declarations = assertPort(declarations, ['get'], 'declaration');
    this.#journal = assertPort(journal, ['current', 'begin', 'advance'], 'journal');
    this.#observer = assertPort(observer, ['observe'], 'observation');
    this.#fence = assertPort(fence, ['acquire'], 'fence');
    this.#construction = assertPort(construction, ['run', 'clear'], 'construction');
    if (evidence != null && typeof evidence.inspect !== 'function') throw new TypeError('environment rebuild evidence contract is incomplete');
    this.#evidence = evidence;
  }

  async #observe(record) {
    const observation = normalizeEnvironmentObservation(await this.#observer.observe(Object.freeze({
      environmentIdentity: record.identity,
      declarationRevision: record.revision,
      declaration: record.declaration,
    })));
    if (observation.environmentIdentity !== record.identity || observation.declarationRevision !== record.revision) throw new Error('environment rebuild observation does not match declaration authority');
    return observation;
  }

  async #diagnose(record, observation) {
    const extra = this.#evidence ? await this.#evidence.inspect(Object.freeze({ record, observation })) : {};
    return diagnoseEnvironment({ declaration: record, observation, activeTransition: 'none', ...extra });
  }

  #assertRebuildable(record, observation, diagnosis, expectedCause = null) {
    if (diagnosis.supportedNextAction !== 'rebuild' || diagnosis.repairableInPlace !== false || !REBUILD_CAUSES.has(diagnosis.cause)) {
      throw new Error(`environment is not rebuildable from the current condition; supported next action: ${diagnosis.supportedNextAction}`);
    }
    if (expectedCause != null && diagnosis.cause !== expectedCause) throw new Error('environment rebuild diagnosis changed during the active operation');
    if (observation.implementationGeneration == null) throw new Error('environment rebuild requires an exact previous implementation generation');
    const impact = impactFor(record, observation, diagnosis);
    if (impact.blocked) throw new Error(`environment rebuild is blocked by protected state: ${impact.protectedState.join(', ')}`);
    return impact;
  }

  async #acquireFence(record) {
    const held = await this.#fence.acquire(Object.freeze({ environmentIdentity: record.environmentIdentity, operationId: record.operationId }));
    if (!held || typeof held.release !== 'function') throw new Error('environment rebuild fence did not return a release contract');
    const subject = safeId(held.subject, 'environment rebuild fence subject');
    const prior = fenceEntry(record)?.fence ?? null;
    if (prior != null && subject !== prior) {
      await held.release();
      throw new Error('environment rebuild fence subject changed during resume');
    }
    return { held, subject };
  }

  async plan(rawIdentity) {
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    const observation = await this.#observe(declaration);
    const diagnosis = await this.#diagnose(declaration, observation);
    if (diagnosis.supportedNextAction !== 'rebuild' || !REBUILD_CAUSES.has(diagnosis.cause)) {
      throw new Error(`environment rebuild is not the supported next action: ${diagnosis.supportedNextAction}`);
    }
    return impactFor(declaration, observation, diagnosis);
  }

  async rebuild(rawIdentity) {
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    let record = await this.#journal.current(identity);
    if (active(record)) {
      if (record.operation !== 'rebuild') throw new Error('another lifecycle operation is active for the environment');
      if (record.declarationRevision !== declaration.revision) throw new Error('active environment rebuild no longer matches declaration authority');
    } else {
      const before = await this.#observe(declaration);
      const selected = await this.#diagnose(declaration, before);
      this.#assertRebuildable(declaration, before, selected);
      record = await this.#journal.begin({ environmentIdentity: identity, operation: 'rebuild', declarationRevision: declaration.revision });
    }

    let held = null;
    try {
      if (lastStage(record) === 'intent') {
        const before = await this.#observe(declaration);
        const selected = await this.#diagnose(declaration, before);
        this.#assertRebuildable(declaration, before, selected);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'pre-observation', outcome: 'diagnosed', subjects: [selected.cause], observation: before,
          implementationGeneration: before.implementationGeneration,
        });
      }

      if (lastStage(record) === 'pre-observation') {
        const acquired = await this.#acquireFence(record);
        held = acquired.held;
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'fenced-attempt', outcome: 'attempted', fence: acquired.subject, subjects: [causeEntry(record)],
          implementationGeneration: preEntry(record).implementationGeneration,
        });
      } else if (['fenced-attempt', 'post-observation', 'verification'].includes(lastStage(record))) {
        held = (await this.#acquireFence(record)).held;
      }

      if (lastStage(record) === 'fenced-attempt') {
        const expectedCause = causeEntry(record);
        const previousGeneration = preEntry(record)?.implementationGeneration ?? null;
        if (previousGeneration == null) throw new Error('environment rebuild previous implementation generation is unavailable');
        const beforeAttempt = await this.#observe(declaration);
        if (beforeAttempt.implementationGeneration === previousGeneration) {
          const selected = await this.#diagnose(declaration, beforeAttempt);
          this.#assertRebuildable(declaration, beforeAttempt, selected, expectedCause);
        }
        const result = await this.#construction.run({
          environmentIdentity: identity,
          operationId: record.operationId,
          declarationRevision: declaration.revision,
          declaration: declaration.declaration,
        });
        if (result.implementationGeneration === previousGeneration) throw new Error('environment rebuild did not create a new implementation generation');
        const after = await this.#observe(declaration);
        if (after.implementationGeneration !== result.implementationGeneration) throw new Error('environment rebuild post-observation generation changed');
        const afterDiagnosis = await this.#diagnose(declaration, after);
        if (afterDiagnosis.state !== 'ready') throw new Error(`environment rebuild did not restore readiness: ${afterDiagnosis.cause}`);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'post-observation', outcome: 'observed', subjects: [expectedCause], observation: after,
          implementationGeneration: result.implementationGeneration,
        });
      }

      if (lastStage(record) === 'post-observation') {
        const verified = await this.#observe(declaration);
        const selected = await this.#diagnose(declaration, verified);
        if (selected.state !== 'ready') throw new Error(`environment rebuild verification is not healthy: ${selected.cause}`);
        const expectedGeneration = record.entries.at(-1).implementationGeneration;
        if (verified.implementationGeneration !== expectedGeneration) throw new Error('environment rebuild verification generation changed');
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'verification', outcome: 'verified', implementationGeneration: expectedGeneration,
          subjects: [causeEntry(record)], observation: verified,
        });
      }

      if (lastStage(record) === 'verification') {
        await this.#construction.clear(record.operationId);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'cleanup-reconciliation', outcome: 'reconciled', implementationGeneration: record.entries.at(-1).implementationGeneration,
          subjects: [causeEntry(record)],
        });
      }
      if (lastStage(record) === 'cleanup-reconciliation') {
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'terminal', outcome: 'complete', implementationGeneration: record.entries.at(-1).implementationGeneration,
          subjects: [causeEntry(record)],
        });
      }
      const terminal = record.entries.at(-1);
      return Object.freeze({
        state: terminal.outcome,
        environmentIdentity: identity,
        operationId: record.operationId,
        previousImplementationGeneration: preEntry(record)?.implementationGeneration ?? null,
        implementationGeneration: terminal.implementationGeneration,
        rebuiltCause: causeEntry(record),
      });
    } finally {
      await held?.release();
    }
  }
}
