import {
  PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
  reconcileProtectedAuthority,
} from './protected-authority-reconciliation.js';

const GENERATION = /^[0-9a-f]{64}$/u;
const DIAGNOSTIC_PROTOCOL = 'devbridge/windows-lifecycle-authority-migration-diagnostic-v1';
const OWNERS = new Set(['absent', 'devbridge', 'foreign', 'ambiguous']);
const MECHANIC_KEYS = new Set([
  'journal',
  'readInstallation',
  'materializeGeneration',
  'verifyGeneration',
  'stopServiceGeneration',
  'configureServiceGeneration',
  'startServiceGeneration',
  'probeServiceGeneration',
  'restoreServiceGeneration',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function exactGeneration(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !GENERATION.test(value)) throw new TypeError(`${name} must be an exact content generation`);
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is invalid`);
  return value;
}

function requireMechanics(mechanics) {
  exactKeys(mechanics, MECHANIC_KEYS, 'Windows lifecycle authority refresh mechanics');
  exactKeys(mechanics.journal, new Set(['load', 'save']), 'Windows lifecycle authority refresh journal');
  requireFunction(mechanics.journal.load, 'Windows lifecycle authority refresh journal load');
  requireFunction(mechanics.journal.save, 'Windows lifecycle authority refresh journal save');
  for (const name of [
    'readInstallation',
    'materializeGeneration',
    'verifyGeneration',
    'stopServiceGeneration',
    'configureServiceGeneration',
    'startServiceGeneration',
    'probeServiceGeneration',
    'restoreServiceGeneration',
  ]) requireFunction(mechanics[name], `Windows lifecycle authority refresh ${name}`);
  return mechanics;
}

function boundedError(error) {
  const text = String(error?.message ?? error ?? 'unknown failure').replace(/[\r\n;]+/gu, ' ').trim();
  return text.slice(0, 1024) || 'unknown failure';
}

function diagnosticReporter(onDiagnostic) {
  if (onDiagnostic != null && typeof onDiagnostic !== 'function') throw new TypeError('Windows lifecycle authority refresh diagnostic port is invalid');
  let sequence = 0;
  return Object.freeze({
    emit(phase, state, detail = null) {
      const event = Object.freeze({
        protocol: DIAGNOSTIC_PROTOCOL,
        sequence: sequence += 1,
        phase,
        state,
        detail,
      });
      try { onDiagnostic?.(event); } catch {}
      return event;
    },
  });
}

async function reported(reporter, phase, detail, operation, project = () => null) {
  reporter.emit(phase, 'attempted', detail);
  try {
    const value = await operation();
    reporter.emit(phase, 'completed', project(value));
    return value;
  } catch (error) {
    reporter.emit(phase, 'failed', Object.freeze({ error: boundedError(error) }));
    throw error;
  }
}

function generationDetail(value) {
  return Object.freeze({ generation: value.generation });
}

function journalDetail(value) {
  return value == null
    ? Object.freeze({ phase: null, outcome: null, pending: null })
    : Object.freeze({ phase: value.phase, outcome: value.outcome, pending: value.pending == null ? null : Object.freeze({ ...value.pending }) });
}

function normalizedInspection(value) {
  exactKeys(value, new Set([
    'owner',
    'serviceGeneration',
    'preparedGeneration',
    'serviceRunning',
    'retainedGenerations',
  ]), 'Windows lifecycle authority refresh inspection');
  if (!OWNERS.has(value.owner)) throw new TypeError('Windows lifecycle authority refresh owner evidence is invalid');
  const serviceGeneration = exactGeneration(value.serviceGeneration, 'Windows lifecycle authority service generation', { nullable: true });
  const preparedGeneration = exactGeneration(value.preparedGeneration, 'Windows lifecycle authority prepared generation', { nullable: true });
  if (typeof value.serviceRunning !== 'boolean') throw new TypeError('Windows lifecycle authority service-running evidence is invalid');
  if (!Array.isArray(value.retainedGenerations) || value.retainedGenerations.length > 8) {
    throw new TypeError('Windows lifecycle authority retained-generation evidence is invalid');
  }
  const retainedGenerations = value.retainedGenerations.map((generation) => exactGeneration(
    generation,
    'Windows lifecycle authority retained generation',
  ));
  if (new Set(retainedGenerations).size !== retainedGenerations.length) {
    throw new TypeError('Windows lifecycle authority retained-generation evidence is ambiguous');
  }
  if (value.serviceRunning && serviceGeneration == null) throw new TypeError('Windows lifecycle authority cannot report a running service without a generation');
  if (serviceGeneration != null && preparedGeneration === serviceGeneration) throw new TypeError('Windows lifecycle authority active and prepared generations cannot alias');
  if (serviceGeneration != null && retainedGenerations.includes(serviceGeneration)) throw new TypeError('Windows lifecycle authority active generation cannot also be retained');
  if (preparedGeneration != null && retainedGenerations.includes(preparedGeneration)) throw new TypeError('Windows lifecycle authority prepared generation cannot also be retained');
  if (value.owner === 'absent' && (serviceGeneration != null || preparedGeneration != null || value.serviceRunning || retainedGenerations.length > 0)) {
    throw new TypeError('absent Windows lifecycle authority inspection contains protected installation state');
  }
  return Object.freeze({
    owner: value.owner,
    serviceGeneration,
    preparedGeneration,
    serviceRunning: value.serviceRunning,
    retainedGenerations: Object.freeze(retainedGenerations),
  });
}

function ownerProjection(owner) {
  if (owner === 'devbridge') return 'owned';
  return owner;
}

function oneGenerationRequest(value, name) {
  exactKeys(value, new Set(['generation']), name);
  return Object.freeze({ generation: exactGeneration(value.generation, `${name} generation`) });
}

function promotionRequest(value) {
  exactKeys(value, new Set(['generation', 'previousGeneration']), 'Windows lifecycle authority promotion request');
  return Object.freeze({
    generation: exactGeneration(value.generation, 'Windows lifecycle authority promotion generation'),
    previousGeneration: exactGeneration(value.previousGeneration, 'Windows lifecycle authority previous generation', { nullable: true }),
  });
}

function restorationRequest(value) {
  exactKeys(value, new Set(['generation', 'failedGeneration']), 'Windows lifecycle authority restoration request');
  return Object.freeze({
    generation: exactGeneration(value.generation, 'Windows lifecycle authority restoration generation'),
    failedGeneration: exactGeneration(value.failedGeneration, 'Windows lifecycle authority failed generation'),
  });
}

function verificationEvidence(value, generation) {
  exactKeys(value, new Set(['generation', 'verified']), 'Windows lifecycle authority generation verification');
  if (exactGeneration(value.generation, 'Windows lifecycle authority verified generation') !== generation || typeof value.verified !== 'boolean') {
    throw new TypeError('Windows lifecycle authority generation verification is invalid');
  }
  return Object.freeze({ generation, verified: value.verified });
}

function healthEvidence(value, generation) {
  exactKeys(value, new Set(['generation', 'ready', 'reason']), 'Windows lifecycle authority generation health');
  if (exactGeneration(value.generation, 'Windows lifecycle authority health generation') !== generation || typeof value.ready !== 'boolean') {
    throw new TypeError('Windows lifecycle authority generation health is invalid');
  }
  if (value.reason != null && (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 1024)) {
    throw new TypeError('Windows lifecycle authority generation health reason is invalid');
  }
  return Object.freeze({ generation, ready: value.ready, reason: value.reason ?? null });
}

function createPorts(local, reporter) {
  return Object.freeze({
    journal: Object.freeze({
      load: () => reported(reporter, 'refresh-journal-load', null, () => local.journal.load(), journalDetail),
      save: (value) => reported(reporter, 'refresh-journal-save', journalDetail(value), () => local.journal.save(value), () => journalDetail(value)),
    }),
    async observe() {
      return reported(reporter, 'refresh-observe', null, async () => {
        const value = normalizedInspection(await local.readInstallation());
        return Object.freeze({
          protocol: PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
          ownership: ownerProjection(value.owner),
          activeGeneration: value.serviceGeneration,
          stagedGeneration: value.preparedGeneration,
          running: value.serviceRunning,
          retainedGenerations: value.retainedGenerations,
        });
      }, (value) => Object.freeze({
        ownership: value.ownership,
        activeGeneration: value.activeGeneration,
        stagedGeneration: value.stagedGeneration,
        running: value.running,
        retainedGenerations: value.retainedGenerations,
      }));
    },
    async stage(value) {
      const request = oneGenerationRequest(value, 'Windows lifecycle authority materialization request');
      return reported(reporter, 'refresh-stage', generationDetail(request), () => local.materializeGeneration(request));
    },
    async verify(value) {
      const request = oneGenerationRequest(value, 'Windows lifecycle authority verification request');
      return reported(reporter, 'refresh-verify', generationDetail(request), async () => verificationEvidence(await local.verifyGeneration(request), request.generation), (result) => result);
    },
    async quiesce(value) {
      const request = oneGenerationRequest(value, 'Windows lifecycle authority service stop request');
      return reported(reporter, 'refresh-quiesce', generationDetail(request), () => local.stopServiceGeneration(request));
    },
    async promote(value) {
      const request = promotionRequest(value);
      return reported(reporter, 'refresh-promote', request, () => local.configureServiceGeneration(request));
    },
    async start(value) {
      const request = oneGenerationRequest(value, 'Windows lifecycle authority service start request');
      return reported(reporter, 'refresh-start', generationDetail(request), () => local.startServiceGeneration(request));
    },
    async health(value) {
      const request = oneGenerationRequest(value, 'Windows lifecycle authority health request');
      reporter.emit('refresh-health', 'attempted', generationDetail(request));
      try {
        const evidence = healthEvidence(await local.probeServiceGeneration(request), request.generation);
        reporter.emit('refresh-health', 'completed', evidence);
        return Object.freeze({ generation: evidence.generation, ready: evidence.ready });
      } catch (error) {
        reporter.emit('refresh-health', 'failed', Object.freeze({ error: boundedError(error) }));
        throw error;
      }
    },
    async restore(value) {
      const request = restorationRequest(value);
      return reported(reporter, 'refresh-restore', request, () => local.restoreServiceGeneration(request));
    },
  });
}

export function createWindowsLifecycleAuthorityRefreshPorts({ mechanics, onDiagnostic = null } = {}) {
  const local = requireMechanics(mechanics);
  return createPorts(local, diagnosticReporter(onDiagnostic));
}

export async function reconcileWindowsLifecycleAuthorityRefresh({ candidateGeneration, mechanics, onDiagnostic = null } = {}) {
  const generation = exactGeneration(candidateGeneration, 'Windows lifecycle authority refresh candidate generation');
  const reporter = diagnosticReporter(onDiagnostic);
  const local = requireMechanics(mechanics);
  reporter.emit('refresh', 'started', Object.freeze({ generation }));
  try {
    const result = await reconcileProtectedAuthority({
      candidate: Object.freeze({ generation }),
      ports: createPorts(local, reporter),
    });
    reporter.emit('refresh', 'completed', Object.freeze({ ready: result.ready, changed: result.changed, recovered: result.recovered, blocker: result.blocker }));
    return result;
  } catch (error) {
    reporter.emit('refresh-diagnose', 'attempted');
    try {
      const inspection = normalizedInspection(await local.readInstallation());
      reporter.emit('refresh-diagnose-observe', 'completed', inspection);
      if (inspection.serviceGeneration != null) {
        const evidence = healthEvidence(
          await local.probeServiceGeneration(Object.freeze({ generation: inspection.serviceGeneration })),
          inspection.serviceGeneration,
        );
        reporter.emit('refresh-diagnose-health', 'completed', evidence);
      }
      reporter.emit('refresh-diagnose', 'completed');
    } catch (diagnosticError) {
      reporter.emit('refresh-diagnose', 'failed', Object.freeze({ error: boundedError(diagnosticError) }));
    }
    reporter.emit('refresh', 'failed', Object.freeze({ error: boundedError(error) }));
    throw error;
  }
}
