import { diagnoseEnvironment } from './environment-diagnosis.js';
import { normalizeEnvironmentObservation } from './environment-observation.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function assertPort(value, methods, name) { if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`environment repair ${name} contract is incomplete`); return value; }
function active(record) { return record != null && record.entries?.at(-1)?.stage !== 'terminal'; }
function lastStage(record) { return record.entries.at(-1).stage; }
function fenceEntry(record) { return record.entries.find((entry) => entry.stage === 'fenced-attempt') ?? null; }
function causeEntry(record) { return record.entries.find((entry) => entry.stage === 'pre-observation')?.subjects?.[0] ?? null; }

export class EnvironmentRepair {
  #declarations; #journal; #observer; #fence; #correction; #evidence;
  constructor({ declarations, journal, observer, fence, correction, evidence = null } = {}) {
    this.#declarations = assertPort(declarations, ['get'], 'declaration');
    this.#journal = assertPort(journal, ['current', 'begin', 'advance'], 'journal');
    this.#observer = assertPort(observer, ['observe'], 'observation');
    this.#fence = assertPort(fence, ['acquire'], 'fence');
    this.#correction = assertPort(correction, ['ensure'], 'correction');
    if (evidence != null && typeof evidence.inspect !== 'function') throw new TypeError('environment repair evidence contract is incomplete');
    this.#evidence = evidence;
  }

  async #observe(record) {
    const observation = normalizeEnvironmentObservation(await this.#observer.observe(Object.freeze({
      environmentIdentity: record.identity,
      declarationRevision: record.revision,
      declaration: record.declaration,
    })));
    if (observation.environmentIdentity !== record.identity || observation.declarationRevision !== record.revision) throw new Error('environment repair observation does not match declaration authority');
    return observation;
  }

  async #diagnose(record, observation) {
    const extra = this.#evidence ? await this.#evidence.inspect(Object.freeze({ record, observation })) : {};
    return diagnoseEnvironment({ declaration: record, observation, activeTransition: 'none', ...extra });
  }

  async #acquireFence(record) {
    const held = await this.#fence.acquire(Object.freeze({ environmentIdentity: record.environmentIdentity, operationId: record.operationId }));
    if (!held || typeof held.release !== 'function') throw new Error('environment repair fence did not return a release contract');
    const subject = safeId(held.subject, 'environment repair fence subject');
    const prior = fenceEntry(record)?.fence ?? null;
    if (prior != null && subject !== prior) {
      await held.release();
      throw new Error('environment repair fence subject changed during resume');
    }
    return { held, subject };
  }

  #assertRepairable(diagnosis, expectedCause = null) {
    if (diagnosis.state === 'ready') return;
    if (diagnosis.repairableInPlace !== true || diagnosis.supportedNextAction !== 'repair') {
      throw new Error(`environment is not repairable in place; supported next action: ${diagnosis.supportedNextAction}`);
    }
    if (expectedCause != null && diagnosis.cause !== expectedCause) throw new Error('environment repair diagnosis changed during the active operation');
  }

  async repair(rawIdentity) {
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    let record = await this.#journal.current(identity);
    if (active(record)) {
      if (record.operation !== 'repair') throw new Error('another lifecycle operation is active for the environment');
      if (record.declarationRevision !== declaration.revision) throw new Error('active environment repair no longer matches declaration authority');
    } else {
      const before = await this.#observe(declaration);
      const selected = await this.#diagnose(declaration, before);
      this.#assertRepairable(selected);
      record = await this.#journal.begin({ environmentIdentity: identity, operation: 'repair', declarationRevision: declaration.revision });
    }

    let held = null;
    try {
      if (lastStage(record) === 'intent') {
        const before = await this.#observe(declaration);
        const selected = await this.#diagnose(declaration, before);
        this.#assertRepairable(selected);
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
          implementationGeneration: record.entries.at(-1).implementationGeneration,
        });
      } else if (['fenced-attempt', 'post-observation', 'verification'].includes(lastStage(record))) {
        held = (await this.#acquireFence(record)).held;
      }

      if (lastStage(record) === 'fenced-attempt') {
        const expectedCause = causeEntry(record);
        const beforeAttempt = await this.#observe(declaration);
        const selected = await this.#diagnose(declaration, beforeAttempt);
        this.#assertRepairable(selected, expectedCause);
        const originalGeneration = record.entries.find((entry) => entry.stage === 'pre-observation')?.implementationGeneration ?? null;
        if (selected.state !== 'ready') {
          await this.#correction.ensure(Object.freeze({
            environmentIdentity: identity,
            operationId: record.operationId,
            declarationRevision: declaration.revision,
            declaration: declaration.declaration,
            implementationGeneration: beforeAttempt.implementationGeneration,
            cause: expectedCause,
          }));
        }
        const after = await this.#observe(declaration);
        if (originalGeneration != null && after.implementationGeneration !== originalGeneration) throw new Error('environment repair changed implementation generation');
        const afterDiagnosis = await this.#diagnose(declaration, after);
        if (afterDiagnosis.state !== 'ready') throw new Error(`environment repair did not restore readiness: ${afterDiagnosis.cause}`);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'post-observation', outcome: 'observed', subjects: [expectedCause], observation: after,
          implementationGeneration: after.implementationGeneration,
        });
      }

      if (lastStage(record) === 'post-observation') {
        const verified = await this.#observe(declaration);
        const selected = await this.#diagnose(declaration, verified);
        if (selected.state !== 'ready') throw new Error(`environment repair verification is not healthy: ${selected.cause}`);
        const expectedGeneration = record.entries.at(-1).implementationGeneration;
        if (verified.implementationGeneration !== expectedGeneration) throw new Error('environment repair verification generation changed');
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'verification', outcome: 'verified', implementationGeneration: expectedGeneration,
          subjects: [causeEntry(record)], observation: verified,
        });
      }

      if (lastStage(record) === 'verification') {
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
      return Object.freeze({ state: terminal.outcome, environmentIdentity: identity, operationId: record.operationId, implementationGeneration: terminal.implementationGeneration, repairedCause: causeEntry(record) });
    } finally {
      await held?.release();
    }
  }
}
