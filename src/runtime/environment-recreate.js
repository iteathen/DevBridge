import { createHash } from 'node:crypto';
import { environmentObservationCondition, normalizeEnvironmentObservation } from './environment-observation.js';

export const ENVIRONMENT_RECREATE_IMPACT_PROTOCOL = 'devbridge/environment-recreate-impact-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const EVIDENCE_STATES = new Set(['ready', 'degraded', 'blocked', 'unknown']);

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
function assertPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`environment recreate ${name} contract is incomplete`);
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
function normalizeOptions(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('environment recreate options must be an object');
  for (const key of Object.keys(raw)) if (key !== 'approval') throw new TypeError(`environment recreate options.${key} is not allowed`);
  return { approval: raw.approval };
}

function impactFor(record, observation, rawEvidence) {
  const evidence = normalizeEvidence(rawEvidence);
  const workspaces = freezeList(record.declaration.workspaces.map((workspace) => workspace.identity));
  const protectedState = freezeList(record.declaration.protectedStateClasses);
  const blockers = [];
  if (!['present', 'missing'].includes(observation.materialization)) blockers.push('provider-selection-unavailable');
  if (observation.implementationGeneration == null) blockers.push('implementation-identity-unavailable');
  if (observation.transition !== 'clear') blockers.push('transition-not-clear');
  if (protectedState.length > 0) blockers.push('protected-state');
  if (evidence.resources !== 'ready') blockers.push('resource-prerequisite');
  const previousProvider = observation.materialization === 'present' ? 'present' : observation.materialization === 'missing' ? 'missing' : 'unavailable';
  const rollback = previousProvider === 'present'
    ? 'superseded-generation-retained-until-verification'
    : previousProvider === 'missing'
      ? 'unavailable-provider-already-missing'
      : 'unavailable';
  const basis = Object.freeze({
    protocol: ENVIRONMENT_RECREATE_IMPACT_PROTOCOL,
    operation: 'recreate',
    destructive: true,
    environmentIdentity: record.identity,
    declarationRevision: record.revision,
    currentImplementationGeneration: observation.implementationGeneration,
    currentMaterialization: observation.materialization,
    currentSystemStorage: observation.systemStorage,
    currentTransition: observation.transition,
    previousProvider,
    replacementStrategy: 'staged-provider-replacement',
    sideBySideReplacement: previousProvider === 'present',
    destructiveFallback: Object.freeze({
      automatic: false,
      rollback: 'unavailable-after-old-provider-retirement',
    }),
    rollback,
    affectedWorkspaces: workspaces,
    affectedWorkspaceCount: workspaces.length,
    preserves: freezeList(['logical-environment', 'desired-declaration', 'workspace-authority', 'lifecycle-provenance']),
    replaces: freezeList(['provider-implementation', 'guest-system-storage', 'provider-attachment-generation', 'guest-machine-identity', 'guest-bridge-identity']),
    reseeds: workspaces,
    discards: freezeList(['guest-system-mutable-state', 'guest-dependencies', 'guest-build-products', 'guest-cache', 'guest-scratch', 'workspace-materialization']),
    protectedState,
    blocked: blockers.length > 0,
    blockers: freezeList(blockers),
    prerequisites: Object.freeze({
      profile: record.declaration.profile,
      imageIdentity: record.declaration.image.identity,
      imageGeneration: record.declaration.image.generation,
      bootRequirement: record.declaration.boot.requirement,
      networkRequirement: record.declaration.network.requirement,
      enrollmentRequirement: record.declaration.enrollment.requirement,
      bootstrapGeneration: record.declaration.bootstrap.generation,
      memoryBytes: record.declaration.resources.memoryBytes,
      processorCount: record.declaration.resources.processorCount,
      resources: evidence.resources,
      network: evidence.network,
      workspaces: evidence.workspaces,
    }),
  });
  const digest = createHash('sha256').update(JSON.stringify(basis), 'utf8').digest('hex');
  return Object.freeze({ ...basis, authorizationSubject: `recreate-${digest}` });
}

function assertRecreatable(impact) {
  if (impact.blockers.includes('provider-selection-unavailable')) throw new Error('environment recreate requires one exact logical provider generation; ambiguous or unavailable provider selection requires manual review');
  if (impact.blockers.includes('implementation-identity-unavailable')) throw new Error('environment recreate requires an exact previous implementation generation');
  if (impact.blockers.includes('transition-not-clear')) throw new Error('environment recreate requires a clear lifecycle observation before destructive authorization');
  if (impact.blockers.includes('protected-state')) throw new Error(`environment recreate is blocked by protected state: ${impact.protectedState.join(', ')}`);
  if (impact.blockers.includes('resource-prerequisite')) throw new Error('environment recreate resource prerequisites are not ready; automatic destructive fallback is not authorized');
  return impact;
}

function unavailableAuthorization() {
  return Object.freeze({ async verify() { throw new Error('environment recreate local destructive authorization is unavailable'); } });
}

export class EnvironmentRecreate {
  #declarations; #journal; #observer; #fence; #construction; #retirement; #evidence; #authorization;

  constructor({ declarations, journal, observer, fence, construction, retirement, evidence = null, authorization = null } = {}) {
    this.#declarations = assertPort(declarations, ['get'], 'declaration');
    this.#journal = assertPort(journal, ['current', 'begin', 'advance'], 'journal');
    this.#observer = assertPort(observer, ['observe'], 'observation');
    this.#fence = assertPort(fence, ['acquire'], 'fence');
    this.#construction = assertPort(construction, ['run', 'clear'], 'construction');
    this.#retirement = assertPort(retirement, ['ensure'], 'retirement');
    if (evidence != null && typeof evidence.inspect !== 'function') throw new TypeError('environment recreate evidence contract is incomplete');
    this.#evidence = evidence;
    this.#authorization = authorization == null ? unavailableAuthorization() : assertPort(authorization, ['verify'], 'authorization');
  }

  async #observe(record) {
    const observation = normalizeEnvironmentObservation(await this.#observer.observe(Object.freeze({
      environmentIdentity: record.identity,
      declarationRevision: record.revision,
      declaration: record.declaration,
    })));
    if (observation.environmentIdentity !== record.identity || observation.declarationRevision !== record.revision) throw new Error('environment recreate observation does not match declaration authority');
    return observation;
  }

  async #impact(record, observation) {
    const evidence = this.#evidence ? await this.#evidence.inspect(Object.freeze({ record, observation })) : {};
    return impactFor(record, observation, evidence);
  }

  async #authorize(impact, approval) {
    if (typeof approval !== 'string' || approval.length === 0 || approval.includes('\0') || Buffer.byteLength(approval, 'utf8') > 1024) {
      throw new TypeError('environment recreate approval receipt is invalid');
    }
    const result = await this.#authorization.verify(Object.freeze({
      operation: 'recreate',
      approval,
      subject: impact.authorizationSubject,
      environmentIdentity: impact.environmentIdentity,
      declarationRevision: impact.declarationRevision,
      implementationGeneration: impact.currentImplementationGeneration,
    }));
    if (result?.approved !== true || result?.subject !== impact.authorizationSubject) throw new Error('environment recreate destructive authorization did not match the exact impact subject');
  }

  async #acquireFence(record) {
    const held = await this.#fence.acquire(Object.freeze({ environmentIdentity: record.environmentIdentity, operationId: record.operationId }));
    if (!held || typeof held.release !== 'function') throw new Error('environment recreate fence did not return a release contract');
    const subject = safeId(held.subject, 'environment recreate fence subject');
    const prior = fenceEntry(record)?.fence ?? null;
    if (prior != null && subject !== prior) {
      await held.release();
      throw new Error('environment recreate fence subject changed during resume');
    }
    return { held, subject };
  }

  async #assertReady(observation) {
    const condition = environmentObservationCondition(observation);
    if (condition !== 'healthy') throw new Error(`environment recreate did not restore readiness: ${condition}`);
  }

  async #annotateRecovery(identity, error) {
    let record = null;
    try { record = await this.#journal.current(identity); } catch {}
    if (active(record) && record.operation === 'recreate') {
      const recovery = Object.freeze({
        state: 'resume-required',
        environmentIdentity: identity,
        operationId: record.operationId,
        stage: lastStage(record),
        previousProvider: preEntry(record)?.observation?.materialization ?? 'unknown',
        instruction: 're-run recreate for the same logical environment with the same approved impact; do not manually delete provider objects selected by the active lifecycle operation',
      });
      try { Object.defineProperty(error, 'recovery', { value: recovery, enumerable: true, configurable: true }); } catch {}
    }
    return error;
  }

  async plan(rawIdentity) {
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    const observation = await this.#observe(declaration);
    return this.#impact(declaration, observation);
  }

  async recreate(rawIdentity, rawOptions = {}) {
    const { approval } = normalizeOptions(rawOptions);
    const identity = safeId(rawIdentity, 'environment identity');
    const declaration = await this.#declarations.get(identity);
    if (!declaration) throw new Error('environment declaration is unavailable; setup re-entry is required');
    let record = await this.#journal.current(identity);
    let authorized = null;
    let authorizedObservation = null;

    if (active(record)) {
      if (record.operation !== 'recreate') throw new Error('another lifecycle operation is active for the environment');
      if (record.declarationRevision !== declaration.revision) throw new Error('active environment recreate no longer matches declaration authority');
    } else {
      authorizedObservation = await this.#observe(declaration);
      authorized = assertRecreatable(await this.#impact(declaration, authorizedObservation));
      await this.#authorize(authorized, approval);
      record = await this.#journal.begin({ environmentIdentity: identity, operation: 'recreate', declarationRevision: declaration.revision });
    }

    let held = null;
    try {
      if (lastStage(record) === 'intent') {
        const before = authorizedObservation ?? await this.#observe(declaration);
        const impact = authorized ?? assertRecreatable(await this.#impact(declaration, before));
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
        if (previousGeneration == null || approvedSubject == null) throw new Error('environment recreate authorized impact evidence is incomplete');
        const beforeAttempt = await this.#observe(declaration);
        if (beforeAttempt.implementationGeneration === previousGeneration) {
          const currentImpact = assertRecreatable(await this.#impact(declaration, beforeAttempt));
          if (currentImpact.authorizationSubject !== approvedSubject) throw new Error('environment recreate impact changed after destructive authorization');
        }
        const result = await this.#construction.run({
          environmentIdentity: identity,
          operationId: record.operationId,
          declarationRevision: declaration.revision,
          declaration: declaration.declaration,
        });
        if (result.implementationGeneration === previousGeneration) throw new Error('environment recreate did not create a new implementation generation');
        const after = await this.#observe(declaration);
        if (after.implementationGeneration !== result.implementationGeneration) throw new Error('environment recreate post-observation generation changed');
        await this.#assertReady(after);
        record = await this.#journal.advance(identity, record.operationId, {
          stage: 'post-observation', outcome: 'observed', subjects: [approvedSubject], observation: after,
          implementationGeneration: result.implementationGeneration,
        });
      }

      if (lastStage(record) === 'post-observation') {
        const verified = await this.#observe(declaration);
        const expectedGeneration = record.entries.at(-1).implementationGeneration;
        if (verified.implementationGeneration !== expectedGeneration) throw new Error('environment recreate verification generation changed');
        await this.#assertReady(verified);
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
      const previousMaterialization = preEntry(record)?.observation?.materialization ?? 'unknown';
      return Object.freeze({
        state: terminal.outcome,
        environmentIdentity: identity,
        operationId: record.operationId,
        previousImplementationGeneration: preEntry(record)?.implementationGeneration ?? null,
        implementationGeneration: terminal.implementationGeneration,
        authorizationSubject: authorizationSubject(record),
        rollback: previousMaterialization === 'present' ? 'retired-after-verification' : 'unavailable-provider-already-missing',
      });
    } catch (error) {
      throw await this.#annotateRecovery(identity, error);
    } finally {
      await held?.release();
    }
  }
}
