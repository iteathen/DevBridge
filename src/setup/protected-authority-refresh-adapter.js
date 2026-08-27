import {
  PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
  reconcileProtectedAuthority,
} from './protected-authority-reconciliation.js';

const GENERATION = /^[0-9a-f]{64}$/u;
const DEFAULT_DIAGNOSTIC_PROTOCOL = 'devbridge/protected-authority-migration-diagnostic-v1';
const DIAGNOSTIC_PROTOCOL = /^devbridge\/[a-z0-9-]+-v[1-9][0-9]*$/u;
const OWNERSHIP_VALUES = new Set(['absent', 'owned', 'foreign', 'ambiguous']);
const MECHANICS_KEYS = new Set([
  'journal',
  'observeInstallation',
  'stageGeneration',
  'verifyGeneration',
  'quiesceGeneration',
  'promoteGeneration',
  'startGeneration',
  'probeGeneration',
  'restoreGeneration',
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
  exactKeys(mechanics, MECHANICS_KEYS, 'protected authority refresh mechanics');
  exactKeys(mechanics.journal, new Set(['load', 'save']), 'protected authority refresh journal');
  requireFunction(mechanics.journal.load, 'protected authority refresh journal load');
  requireFunction(mechanics.journal.save, 'protected authority refresh journal save');
  for (const name of [
    'observeInstallation',
    'stageGeneration',
    'verifyGeneration',
    'quiesceGeneration',
    'promoteGeneration',
    'startGeneration',
    'probeGeneration',
    'restoreGeneration',
  ]) requireFunction(mechanics[name], `protected authority refresh ${name}`);
  return mechanics;
}

function boundedError(error) {
  const text = String(error?.message ?? error ?? 'unknown failure').replace(/[\r\n;]+/gu, ' ').trim();
  return text.slice(0, 1024) || 'unknown failure';
}

function diagnosticReporter(onDiagnostic, protocol) {
  if (onDiagnostic != null && typeof onDiagnostic !== 'function') throw new TypeError('protected authority refresh diagnostic port is invalid');
  if (typeof protocol !== 'string' || !DIAGNOSTIC_PROTOCOL.test(protocol)) {
    throw new TypeError('protected authority refresh diagnostic protocol is invalid');
  }
  let sequence = 0;
  return Object.freeze({
    emit(phase, state, detail = null) {
      const event = Object.freeze({
        protocol,
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
    'ownership',
    'activeGeneration',
    'stagedGeneration',
    'running',
    'retainedGenerations',
  ]), 'protected authority refresh inspection');
  if (!OWNERSHIP_VALUES.has(value.ownership)) throw new TypeError('protected authority refresh ownership evidence is invalid');
  const activeGeneration = exactGeneration(value.activeGeneration, 'protected authority active generation', { nullable: true });
  const stagedGeneration = exactGeneration(value.stagedGeneration, 'protected authority staged generation', { nullable: true });
  if (typeof value.running !== 'boolean') throw new TypeError('protected authority running evidence is invalid');
  if (!Array.isArray(value.retainedGenerations) || value.retainedGenerations.length > 8) {
    throw new TypeError('protected authority retained-generation evidence is invalid');
  }
  const retainedGenerations = value.retainedGenerations.map((generation) => exactGeneration(
    generation,
    'protected authority retained generation',
  ));
  if (new Set(retainedGenerations).size !== retainedGenerations.length) {
    throw new TypeError('protected authority retained-generation evidence is ambiguous');
  }
  if (value.running && activeGeneration == null) throw new TypeError('protected authority cannot report a running service without a generation');
  if (activeGeneration != null && stagedGeneration === activeGeneration) throw new TypeError('protected authority active and prepared generations cannot alias');
  if (activeGeneration != null && retainedGenerations.includes(activeGeneration)) throw new TypeError('protected authority active generation cannot also be retained');
  if (stagedGeneration != null && retainedGenerations.includes(stagedGeneration)) throw new TypeError('protected authority prepared generation cannot also be retained');
  if (value.ownership === 'absent' && (activeGeneration != null || stagedGeneration != null || value.running || retainedGenerations.length > 0)) {
    throw new TypeError('absent protected authority inspection contains protected installation state');
  }
  return Object.freeze({
    ownership: value.ownership,
    activeGeneration,
    stagedGeneration,
    running: value.running,
    retainedGenerations: Object.freeze(retainedGenerations),
  });
}

function oneGenerationRequest(value, name) {
  exactKeys(value, new Set(['generation']), name);
  return Object.freeze({ generation: exactGeneration(value.generation, `${name} generation`) });
}

function promotionRequest(value) {
  exactKeys(value, new Set(['generation', 'previousGeneration']), 'protected authority promotion request');
  return Object.freeze({
    generation: exactGeneration(value.generation, 'protected authority promotion generation'),
    previousGeneration: exactGeneration(value.previousGeneration, 'protected authority previous generation', { nullable: true }),
  });
}

function restorationRequest(value) {
  exactKeys(value, new Set(['generation', 'failedGeneration']), 'protected authority restoration request');
  return Object.freeze({
    generation: exactGeneration(value.generation, 'protected authority restoration generation'),
    failedGeneration: exactGeneration(value.failedGeneration, 'protected authority failed generation'),
  });
}

function verificationEvidence(value, generation) {
  exactKeys(value, new Set(['generation', 'verified']), 'protected authority generation verification');
  if (exactGeneration(value.generation, 'protected authority verified generation') !== generation || typeof value.verified !== 'boolean') {
    throw new TypeError('protected authority generation verification is invalid');
  }
  return Object.freeze({ generation, verified: value.verified });
}

function healthEvidence(value, generation) {
  exactKeys(value, new Set(['generation', 'ready', 'reason']), 'protected authority generation health');
  if (exactGeneration(value.generation, 'protected authority health generation') !== generation || typeof value.ready !== 'boolean') {
    throw new TypeError('protected authority generation health is invalid');
  }
  if (value.reason != null && (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 1024)) {
    throw new TypeError('protected authority generation health reason is invalid');
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
        const value = normalizedInspection(await local.observeInstallation());
        return Object.freeze({
          protocol: PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
          ownership: value.ownership,
          activeGeneration: value.activeGeneration,
          stagedGeneration: value.stagedGeneration,
          running: value.running,
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
      const request = oneGenerationRequest(value, 'protected authority materialization request');
      return reported(reporter, 'refresh-stage', generationDetail(request), () => local.stageGeneration(request));
    },
    async verify(value) {
      const request = oneGenerationRequest(value, 'protected authority verification request');
      return reported(reporter, 'refresh-verify', generationDetail(request), async () => verificationEvidence(await local.verifyGeneration(request), request.generation), (result) => result);
    },
    async quiesce(value) {
      const request = oneGenerationRequest(value, 'protected authority service stop request');
      return reported(reporter, 'refresh-quiesce', generationDetail(request), () => local.quiesceGeneration(request));
    },
    async promote(value) {
      const request = promotionRequest(value);
      return reported(reporter, 'refresh-promote', request, () => local.promoteGeneration(request));
    },
    async start(value) {
      const request = oneGenerationRequest(value, 'protected authority service start request');
      return reported(reporter, 'refresh-start', generationDetail(request), () => local.startGeneration(request));
    },
    async health(value) {
      const request = oneGenerationRequest(value, 'protected authority health request');
      reporter.emit('refresh-health', 'attempted', generationDetail(request));
      try {
        const evidence = healthEvidence(await local.probeGeneration(request), request.generation);
        reporter.emit('refresh-health', 'completed', evidence);
        return Object.freeze({ generation: evidence.generation, ready: evidence.ready });
      } catch (error) {
        reporter.emit('refresh-health', 'failed', Object.freeze({ error: boundedError(error) }));
        throw error;
      }
    },
    async restore(value) {
      const request = restorationRequest(value);
      return reported(reporter, 'refresh-restore', request, () => local.restoreGeneration(request));
    },
  });
}

export function createProtectedAuthorityRefreshPorts({
  mechanics,
  onDiagnostic = null,
  diagnosticProtocol = DEFAULT_DIAGNOSTIC_PROTOCOL,
} = {}) {
  const local = requireMechanics(mechanics);
  return createPorts(local, diagnosticReporter(onDiagnostic, diagnosticProtocol));
}

export async function reconcileProtectedAuthorityRefresh({
  candidateGeneration,
  mechanics,
  onDiagnostic = null,
  diagnosticProtocol = DEFAULT_DIAGNOSTIC_PROTOCOL,
} = {}) {
  const generation = exactGeneration(candidateGeneration, 'protected authority refresh candidate generation');
  const reporter = diagnosticReporter(onDiagnostic, diagnosticProtocol);
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
      const inspection = normalizedInspection(await local.observeInstallation());
      reporter.emit('refresh-diagnose-observe', 'completed', inspection);
      if (inspection.activeGeneration != null) {
        const evidence = healthEvidence(
          await local.probeGeneration(Object.freeze({ generation: inspection.activeGeneration })),
          inspection.activeGeneration,
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
