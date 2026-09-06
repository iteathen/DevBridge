import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATOR_BACKEND_CHECK,
  ACCELERATOR_BACKEND_CHECK_STATE,
  ACCELERATOR_BACKEND_DISPOSITION,
  ACCELERATOR_BACKEND_INVENTORY_PROTOCOL,
  ACCELERATOR_BACKEND_OBSERVATION_PROTOCOL,
  ACCELERATOR_BACKEND_REASON,
  createAcceleratorBackendInventory,
  createAcceleratorBackendObservation,
  normalizeAcceleratorBackendInventory,
  normalizeAcceleratorBackendObservation,
} from '../src/runtime/accelerator-backend-inventory.js';

function ready() { return { state: ACCELERATOR_BACKEND_CHECK_STATE.READY, reason: null }; }
function unknown(reason) { return { state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN, reason }; }
function blocked(reason) { return { state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED, reason }; }

function candidateChecks() {
  return {
    [ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM]: ready(),
    [ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME]: ready(),
    [ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT]: ready(),
    [ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME]: ready(),
    [ACCELERATOR_BACKEND_CHECK.BOUNDARY_TRANSPORT]: unknown(ACCELERATOR_BACKEND_REASON.TRANSPORT_UNPROVEN),
    [ACCELERATOR_BACKEND_CHECK.SECURITY_BOUNDARY]: unknown(ACCELERATOR_BACKEND_REASON.SECURITY_UNPROVEN),
  };
}

function observation(subject, checks = candidateChecks()) {
  return createAcceleratorBackendObservation({
    subject,
    generation: `backend-generation-${subject.slice(-1)}`,
    api: 'cuda',
    topology: 'host-retained',
    checks,
  });
}

test('core readiness can classify a backend candidate while transport and security remain unproven', () => {
  const result = observation('accelerator-backend-0123456789abcdef');
  assert.equal(result.disposition, ACCELERATOR_BACKEND_DISPOSITION.CANDIDATE);
  assert.equal(result.checks.boundaryTransport.state, 'unknown');
  assert.equal(result.checks.securityBoundary.state, 'unknown');
});

test('a blocked check blocks the backend candidate', () => {
  const checks = candidateChecks();
  checks.acceleratorRuntime = blocked(ACCELERATOR_BACKEND_REASON.ACCELERATOR_INCOMPATIBLE);
  assert.equal(observation('accelerator-backend-a', checks).disposition, ACCELERATOR_BACKEND_DISPOSITION.BLOCKED);
});

test('an unknown essential check keeps the backend unknown', () => {
  const checks = candidateChecks();
  checks.backendEnvironment = unknown(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_OBSERVATION_FAILED);
  assert.equal(observation('accelerator-backend-b', checks).disposition, ACCELERATOR_BACKEND_DISPOSITION.UNKNOWN);
});

test('normalization rejects a disposition inconsistent with checks', () => {
  assert.throws(() => normalizeAcceleratorBackendObservation({
    protocol: ACCELERATOR_BACKEND_OBSERVATION_PROTOCOL,
    subject: 'accelerator-backend-c', generation: 'backend-generation-c', api: 'cuda', topology: 'host-retained',
    disposition: 'candidate',
    checks: { ...candidateChecks(), acceleratorRuntime: blocked(ACCELERATOR_BACKEND_REASON.ACCELERATOR_UNAVAILABLE) },
  }), /disposition does not match/u);
});

test('normalization rejects provider-shaped extensions', () => {
  assert.throws(() => normalizeAcceleratorBackendObservation({
    protocol: ACCELERATOR_BACKEND_OBSERVATION_PROTOCOL,
    subject: 'accelerator-backend-d', generation: 'backend-generation-d', api: 'cuda', topology: 'host-retained',
    disposition: 'candidate', checks: candidateChecks(), provider: 'forbidden',
  }), /provider is not allowed/u);
});

test('ready checks cannot carry reasons and non-ready reasons are closed/category-bound', () => {
  const invalidReady = candidateChecks();
  invalidReady.hostPlatform = { state: 'ready', reason: ACCELERATOR_BACKEND_REASON.PLATFORM_UNSUPPORTED };
  assert.throws(() => observation('accelerator-backend-e', invalidReady), /ready accelerator backend check/u);

  const invalidReason = candidateChecks();
  invalidReason.hostPlatform = { state: 'blocked', reason: ACCELERATOR_BACKEND_REASON.RUNTIME_UNAVAILABLE };
  assert.throws(() => observation('accelerator-backend-f', invalidReason), /inconsistent with its check\/state/u);
});

test('inventory can carry multiple independent backend observations without selecting one', () => {
  const blockedChecks = candidateChecks();
  blockedChecks.backendRuntime = blocked(ACCELERATOR_BACKEND_REASON.RUNTIME_UNAVAILABLE);
  const result = createAcceleratorBackendInventory([
    observation('accelerator-backend-z', blockedChecks),
    observation('accelerator-backend-a'),
  ]);
  assert.equal(result.protocol, ACCELERATOR_BACKEND_INVENTORY_PROTOCOL);
  assert.deepEqual(result.observations.map((entry) => entry.subject), ['accelerator-backend-a', 'accelerator-backend-z']);
  assert.deepEqual(result.observations.map((entry) => entry.disposition), ['candidate', 'blocked']);
  assert.equal('selected' in result, false);
  assert.equal('preferred' in result, false);
});

test('inventory rejects duplicate subjects and provider-shaped aggregate fields', () => {
  const first = observation('accelerator-backend-a');
  assert.throws(() => createAcceleratorBackendInventory([first, first]), /duplicate subjects/u);
  assert.throws(() => normalizeAcceleratorBackendInventory({
    protocol: ACCELERATOR_BACKEND_INVENTORY_PROTOCOL,
    observations: [first],
    selectedBackend: 'accelerator-backend-a',
  }), /selectedBackend is not allowed/u);
});
