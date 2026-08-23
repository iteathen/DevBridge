import { createHash } from 'node:crypto';
import { diagnoseEnvironment } from './environment-diagnosis.js';
import { normalizeEnvironmentObservation } from './environment-observation.js';

export const ENVIRONMENT_RESET_IMPACT_PROTOCOL = 'devbridge/environment-reset-impact-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const EVIDENCE_STATES = new Set(['ready', 'degraded', 'blocked', 'unknown']);

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
function assertPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`environment reset ${name} contract is incomplete`);
  return value;
}
function active(record) { return record != null && record.entries?.at(-1)?.stage !== 'terminal'; }
function lastStage(record) { return record.entries.at(-1).stage; }
function fenceEntry(record) { return record.entries.find((entry) => entry.stage === 'fenced-attempt') ?? null; }
function preEntry(record) { return record.entries.find((entry) => entry.stage === 'pre-observation') ?? null; }
function authorizationSubject(record) { return preEntry(record)?.subjects?.[0] ?? null; }
function evidenceState(value) { return EVIDENCE_STATES.has(value) ? value : 'unknown'; }
function normalizeEvidence(raw = {}) {
  return Object.freeze({
    resources: evidenceState(raw?.resources),
    network: evidenceState(raw?.network),
    workspaces: evidenceState(raw?.workspaces),
  });
}
function freezeList(values) { return Object.freeze([...values]); }

function impactFor(record, observation, rawEvidence) {
  const evidence = normalizeEvidence(rawEvidence);
  const protectedState = freezeList(record.declaration.protectedStateClasses);
  const workspaces = freezeList(record.declaration.workspaces.map((workspace) => workspace.identity));
  const basis = Object.freeze({
    protocol: ENVIRONMENT_RESET_IMPACT_PROTOCOL,
    environmentIdentity: record.identity,
    declarationRevision: record.revision,
    currentImplementationGeneration: observation.implementationGeneration,
    currentSystemStorage: observation.systemStorage,
    target: Object.freeze({
      imageIdentity: record.declaration.image.identity,
      imageGeneration: record.declaration.image.generation,
      bootstrapGeneration: record.declaration.bootstrap.generation,
    }),
    affectedWorkspaces: workspaces,
    preserves: freezeList(['logical-environment', 'desired-declaration', 'workspace-authority']),
    discards: freezeList(['guest-system-mutable-state', 'guest-dependencies', 'guest-build-products', 'guest-cache', 'guest-scratch', 'workspace-materialization']),
    protectedState,
    implementationGenerationChanges: true,
    rollback: 'superseded-generation-retained-until-verification',
    prerequisites: Object.freeze({
      profile: record.declaration.profile,
      imageIdentity: record.declaration.image.identity,
      imageGeneration: record.declaration.image.generation,
      bootRequirement: record.declaration.boot.requirement,
      networkRequirement: record.declaration.network.requirement,
      enrollmentRequirement: record.declaration.enrollment.requirement,
      memoryBytes: record.declaration.resources.memoryBytes,
      processorCount: record.declaration.resources.processorCount,
      resources: evidence.resources,
      network: evidence.network,
      workspaces: evidence.workspaces,
    }),
  });
  const digest = createHash('sha256').update(JSON.stringify(basis), 'utf8').digest('hex');
  return Object.freeze({ ...basis, authorizationSubject: `reset-${digest}` });
}

function assertResettable(impact, observation) {
  if (observation.materialization !== 'present' || impact.currentImplementationGeneration == null) {
    throw new Error('environment reset requires an exact current provider implementation; recreate is required when it is missing or ambiguous');
  }
  if (observation.transition !== 'clear') throw new Error('environment reset requires a clear lifecycle observation before destructive authorization');
  if (impact.protectedState.length > 0) throw new Error(`environment reset is blocked by protected state: ${impact.protectedState.join(', ')}`);
  if (impact.prerequisites.resources !== 'ready') throw new Error('environment reset resource prerequisites are not ready');
  return impact;
}

function unavailableAuthorization() {
  return Object.freeze({ async verify() { throw new Error('environment reset local destructive authorization is unavailable'); } });
}

export class EnvironmentReset {
  #declarations; #journal; #observer; #fence; #construction; #retirement; #evidence; #authorization;

  constructor({ declarations, journal, observer, fence, construction, retirement, evidence = null, authorization = null } = {}) {
    this.#declarations = assertPort(declarations, ['get'], 'declaration');
    this.#journal = assertPort(journal, ['current', 'begin', 'advance'], 'journal');
    this.#observer = assertPort(observer, ['observe'], 'observation');
    this.#fence = assertPort(fence, ['acquire'], 'fence');
    this.#construction = assertPort(construction, ['run', 'clear'], 'construction');
    this.#retirement = assertPort(retirement, ['ensure'], 'retirement');
    if (evidence != null && typeof evidence.inspect !== 'function') throw new TypeError('environment reset evidence contract is incomplete');
    this.#evidence = evidence;
    this.#authorization = authorization == null ? unavailableAuthorization() : assertPort(authorization, ['verify'], 'authorization');
  }

  async #observe(record) {
    const observation = normalizeEnvironmentObservation(await this.#observer.observe(Object.freeze({
      environmentIdentity: record.identity,
      declarationRevision: record.revision,
      declaration: record.declaration,
    })));
    if (observation.environmentIdentity !== record.identity || observation.declarationRevision !== record.revision) throw new Error('environment reset observation does not match declaration authority');
    return observation;
  }

  async #evidenceFor(record, observation) {
    return normalizeEvidence(this.#evidence ? await this.#evidence.inspect(Object.freeze({ record, observation })) : {});
  }

  async #impact(record, observation) {
    return impactFor(record, observation, await this.#evidenceFor(record, observation));
  }

  async #authorize(impact, approval) {
    if (typeof approval !== 'string' || approval.length === 0 || approval.includes('\0') || Buffer.byteLength(approval, 'utf8') > 1024) {
      throw new TypeError('environment reset approval receipt is invalid');
    }
    const result = await this.#authorization.verify(Object.freeze({
      operation: 'reset',
      approval,
      subject: impact.authorizationSubject,
      environmentIdentity: impact.environmentIdentity,
      declarationRevision: impact.declarationRevision,
      implementationGeneration: impact.currentImplementationGeneration,
    }));
    if (result?.approved !== true || result?.subject !== impact.authorizationSubject) throw new Error('environment reset destructive authorization did not match the exact impact subject');
  }

  async #acquireFence(record) {
    const held = await this.#fence.acquire(Object.freeze({ environmentIdentity: record.environmentIdentity, operationId: record.operationId }));
    if (!held || typeof held.release !== 'function') throw new Error('environment reset fence did not return a release contract');
    const subject = safeId(held.subject, 'environment reset fence subject');
    const prior = fenceEntry(record)?.fence ?? null;
    if (prior != null && subject !== prior) {
      await held.release();
      throw new Error('environment reset fence subject changed during resume');
    }
    return { held, subject };
  }

  async #assertReady(record, observation) {
    const evidence = await this.#evidenceFor(record, observation);
    const diagnosis = diagnoseEnvironment({ declaration: record, observation, activeTransition: 'none', ...evidence });
    if (diagnosis.state !== 'ready') throw new Error(`environment reset did not restore readiness: ${diagnosis.cause}`);
  }

  async plan(rawIdentity) {
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    const observation = await this.#observe(declaration);
    return assertResettable(await this.#impact(declaration, observation), observation);
  }

  async reset(rawIdentity, { approval } = {}) {
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    let record = await this.#journal.current(identity);
    let authorized = null;
    let authorizedObservation = null;

    if (active(record)) {
      if (record.operation !== 'reset') throw new Error('another lifecycle operation is active for the environment');
      if (record.declarationRevision !== declaration.revision) throw new Error('active environment reset no longer matches declaration authority');
    } else {
      authorizedObservation = await this.#observe(declaration);
      authorized = assertResettable(await this.#impact(declaration, authorizedObservation), authorizedObservation);
      await this.#authorize(authorized, approval);
      record = await this.#journal.begin({ environmentIdentity: identity, operation: 'reset', declarationRevision: declaration.revision });
    }

    let held = null;
    try {
      if (lastStage(record) === 'intent') {
        const before = authorizedObservation ?? await this.#observe(declaration);
        const impact = authorized ?? assertResettable(await this.#impact(declaration, before), before);
        if (authorized == null) await this.#authorize(impact, approval);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'pre-observation', outcome: 'authorized', subjects: [impact.authorizationSubject], observation: before,
          implementationGeneration: before.implementationGeneration,
        });
      }

      if (lastStage(record) === 'pre-observation') {
        const acquired = await this.#acquireFence(record);
        held = acquired.held;
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'fenced-attempt', outcome: 'attempted', fence: acquired.subject, subjects: [authorizationSubject(record)],
          implementationGeneration: preEntry(record).implementationGeneration,
        });
      } else if (['fenced-attempt', 'post-observation', 'verification'].includes(lastStage(record))) {
        held = (await this.#acquireFence(record)).held;
      }

      if (lastStage(record) === 'fenced-attempt') {
        const previousGeneration = preEntry(record)?.implementationGeneration ?? null;
        const approvedSubject = authorizationSubject(record);
        if (previousGeneration == null || approvedSubject == null) throw new Error('environment reset authorized impact evidence is incomplete');
        const beforeAttempt = await this.#observe(declaration);
        const currentImpact = assertResettable(await this.#impact(declaration, beforeAttempt), beforeAttempt);
        if (beforeAttempt.implementationGeneration !== previousGeneration || currentImpact.authorizationSubject !== approvedSubject) {
          throw new Error('environment reset impact changed after destructive authorization');
        }
        const result = await this.#construction.run({
          environmentIdentity: identity,
          operationId: record.operationId,
          declarationRevision: declaration.revision,
          declaration: declaration.declaration,
        });
        if (result.implementationGeneration === previousGeneration) throw new Error('environment reset did not create a new implementation generation');
        const after = await this.#observe(declaration);
        if (after.implementationGeneration !== result.implementationGeneration) throw new Error('environment reset post-observation generation changed');
        await this.#assertReady(declaration, after);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'post-observation', outcome: 'observed', subjects: [approvedSubject], observation: after,
          implementationGeneration: result.implementationGeneration,
        });
      }

      if (lastStage(record) === 'post-observation') {
        const verified = await this.#observe(declaration);
        const expectedGeneration = record.entries.at(-1).implementationGeneration;
        if (verified.implementationGeneration !== expectedGeneration) throw new Error('environment reset verification generation changed');
        await this.#assertReady(declaration, verified);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'verification', outcome: 'verified', implementationGeneration: expectedGeneration,
          subjects: [authorizationSubject(record)], observation: verified,
        });
      }

      if (lastStage(record) === 'verification') {
        const previousGeneration = preEntry(record)?.implementationGeneration ?? null;
        const currentGeneration = record.entries.at(-1).implementationGeneration;
        await this.#retirement.ensure(Object.freeze({
          environmentIdentity: identity,
          operationId: record.operationId,
          declarationRevision: declaration.revision,
          previousImplementationGeneration: previousGeneration,
          implementationGeneration: currentGeneration,
          authorizationSubject: authorizationSubject(record),
        }));
        await this.#construction.clear(record.operationId);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'cleanup-reconciliation', outcome: 'reconciled', implementationGeneration: currentGeneration,
          subjects: [authorizationSubject(record)],
        });
      }

      if (lastStage(record) === 'cleanup-reconciliation') {
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'terminal', outcome: 'complete', implementationGeneration: record.entries.at(-1).implementationGeneration,
          subjects: [authorizationSubject(record)],
        });
      }

      const terminal = record.entries.at(-1);
      return Object.freeze({
        state: terminal.outcome,
        environmentIdentity: identity,
        operationId: record.operationId,
        previousImplementationGeneration: preEntry(record)?.implementationGeneration ?? null,
        implementationGeneration: terminal.implementationGeneration,
        authorizationSubject: authorizationSubject(record),
      });
    } finally {
      await held?.release();
    }
  }
}
