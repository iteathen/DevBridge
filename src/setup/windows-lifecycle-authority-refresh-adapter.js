import {
  PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
  reconcileProtectedAuthority,
} from './protected-authority-reconciliation.js';

const GENERATION = /^[0-9a-f]{64}$/u;
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
  exactKeys(value, new Set(['generation', 'ready']), 'Windows lifecycle authority generation health');
  if (exactGeneration(value.generation, 'Windows lifecycle authority health generation') !== generation || typeof value.ready !== 'boolean') {
    throw new TypeError('Windows lifecycle authority generation health is invalid');
  }
  return Object.freeze({ generation, ready: value.ready });
}

export function createWindowsLifecycleAuthorityRefreshPorts({ mechanics } = {}) {
  const local = requireMechanics(mechanics);
  return Object.freeze({
    journal: Object.freeze({
      load: () => local.journal.load(),
      save: (value) => local.journal.save(value),
    }),
    async observe() {
      const value = normalizedInspection(await local.readInstallation());
      return Object.freeze({
        protocol: PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
        ownership: ownerProjection(value.owner),
        activeGeneration: value.serviceGeneration,
        stagedGeneration: value.preparedGeneration,
        running: value.serviceRunning,
        retainedGenerations: value.retainedGenerations,
      });
    },
    async stage(value) {
      return local.materializeGeneration(oneGenerationRequest(value, 'Windows lifecycle authority materialization request'));
    },
    async verify(value) {
      const request = oneGenerationRequest(value, 'Windows lifecycle authority verification request');
      return verificationEvidence(await local.verifyGeneration(request), request.generation);
    },
    async quiesce(value) {
      return local.stopServiceGeneration(oneGenerationRequest(value, 'Windows lifecycle authority service stop request'));
    },
    async promote(value) {
      return local.configureServiceGeneration(promotionRequest(value));
    },
    async start(value) {
      return local.startServiceGeneration(oneGenerationRequest(value, 'Windows lifecycle authority service start request'));
    },
    async health(value) {
      const request = oneGenerationRequest(value, 'Windows lifecycle authority health request');
      return healthEvidence(await local.probeServiceGeneration(request), request.generation);
    },
    async restore(value) {
      return local.restoreServiceGeneration(restorationRequest(value));
    },
  });
}

export async function reconcileWindowsLifecycleAuthorityRefresh({ candidateGeneration, mechanics } = {}) {
  const generation = exactGeneration(candidateGeneration, 'Windows lifecycle authority refresh candidate generation');
  return reconcileProtectedAuthority({
    candidate: Object.freeze({ generation }),
    ports: createWindowsLifecycleAuthorityRefreshPorts({ mechanics }),
  });
}
