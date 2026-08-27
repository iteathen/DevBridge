import {
  createProtectedAuthorityRefreshPorts,
  reconcileProtectedAuthorityRefresh,
} from './protected-authority-refresh-adapter.js';

const DIAGNOSTIC_PROTOCOL = 'devbridge/windows-lifecycle-authority-migration-diagnostic-v1';
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
const INSPECTION_KEYS = new Set([
  'owner',
  'serviceGeneration',
  'preparedGeneration',
  'serviceRunning',
  'retainedGenerations',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function ownership(value) {
  return value === 'devbridge' ? 'owned' : value;
}

function projectInspection(value) {
  const observed = exactKeys(value, INSPECTION_KEYS, 'Windows lifecycle authority refresh inspection');
  return Object.freeze({
    ownership: ownership(observed.owner),
    activeGeneration: observed.serviceGeneration,
    stagedGeneration: observed.preparedGeneration,
    running: observed.serviceRunning,
    retainedGenerations: observed.retainedGenerations,
  });
}

function projectMechanics(mechanics) {
  const local = exactKeys(mechanics, MECHANIC_KEYS, 'Windows lifecycle authority refresh mechanics');
  return Object.freeze({
    journal: local.journal,
    observeInstallation: async () => projectInspection(await local.readInstallation()),
    stageGeneration: (request) => local.materializeGeneration(request),
    verifyGeneration: (request) => local.verifyGeneration(request),
    quiesceGeneration: (request) => local.stopServiceGeneration(request),
    promoteGeneration: (request) => local.configureServiceGeneration(request),
    startGeneration: (request) => local.startServiceGeneration(request),
    probeGeneration: (request) => local.probeServiceGeneration(request),
    restoreGeneration: (request) => local.restoreServiceGeneration(request),
  });
}

export function createWindowsLifecycleAuthorityRefreshPorts({ mechanics, onDiagnostic = null } = {}) {
  return createProtectedAuthorityRefreshPorts({
    mechanics: projectMechanics(mechanics),
    onDiagnostic,
    diagnosticProtocol: DIAGNOSTIC_PROTOCOL,
  });
}

export async function reconcileWindowsLifecycleAuthorityRefresh({ candidateGeneration, mechanics, onDiagnostic = null } = {}) {
  return await reconcileProtectedAuthorityRefresh({
    candidateGeneration,
    mechanics: projectMechanics(mechanics),
    onDiagnostic,
    diagnosticProtocol: DIAGNOSTIC_PROTOCOL,
  });
}
