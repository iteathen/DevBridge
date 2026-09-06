import {
  assertAcceleratorBrokerObservationTransition,
  digestAcceleratorBrokerCancelRequest,
  digestAcceleratorBrokerExecuteRequest,
  normalizeAcceleratorBrokerCancelRequest,
  normalizeAcceleratorBrokerExecuteRequest,
  normalizeAcceleratorBrokerObservation,
} from './accelerator-broker-protocol.js';

export const ACCELERATOR_BROKER_LEDGER_PROTOCOL = 'devbridge/accelerator-broker-ledger-record-v1';

const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REVISION) throw new TypeError('accelerator broker ledger revision is invalid');
  return value;
}

function sameBinding(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertObservationOwnsRequest(observation, request, requestDigest) {
  if (observation.requestId !== request.requestId
    || observation.executionId !== request.executionId
    || observation.requestDigest !== requestDigest
    || observation.api !== request.api
    || observation.topology !== request.topology
    || observation.operation !== request.operation
    || !sameBinding(observation.binding, request.binding)) {
    throw new TypeError('accelerator broker ledger observation does not belong to request');
  }
}

function normalizeCancelIntent(raw, request, requestDigest) {
  if (raw == null) return null;
  const value = requireObject(raw, 'accelerator broker ledger cancel intent');
  onlyKeys(value, new Set(['request', 'digest']), 'accelerator broker ledger cancel intent');
  const cancel = normalizeAcceleratorBrokerCancelRequest(value.request);
  const expectedDigest = digestAcceleratorBrokerCancelRequest(cancel);
  if (value.digest !== expectedDigest) throw new TypeError('accelerator broker ledger cancel digest does not match request');
  if (cancel.requestId !== request.requestId
    || cancel.executionId !== request.executionId
    || cancel.requestDigest !== requestDigest
    || !sameBinding(cancel.binding, request.binding)) {
    throw new TypeError('accelerator broker ledger cancel intent does not belong to execution');
  }
  return Object.freeze({ request: cancel, digest: expectedDigest });
}

export function normalizeAcceleratorBrokerLedgerKey(raw) {
  const value = requireObject(raw, 'accelerator broker ledger key');
  onlyKeys(value, new Set(['sessionIdentity', 'sessionGeneration', 'requestId']), 'accelerator broker ledger key');
  return Object.freeze({
    sessionIdentity: safeId(value.sessionIdentity, 'accelerator broker ledger key.sessionIdentity'),
    sessionGeneration: safeId(value.sessionGeneration, 'accelerator broker ledger key.sessionGeneration'),
    requestId: safeId(value.requestId, 'accelerator broker ledger key.requestId'),
  });
}

export function acceleratorBrokerLedgerKey(rawRequest) {
  const request = normalizeAcceleratorBrokerExecuteRequest(rawRequest);
  return normalizeAcceleratorBrokerLedgerKey({
    sessionIdentity: request.binding.session.identity,
    sessionGeneration: request.binding.session.generation,
    requestId: request.requestId,
  });
}

export function acceleratorBrokerCancelLedgerKey(rawCancel) {
  const cancel = normalizeAcceleratorBrokerCancelRequest(rawCancel);
  return normalizeAcceleratorBrokerLedgerKey({
    sessionIdentity: cancel.binding.session.identity,
    sessionGeneration: cancel.binding.session.generation,
    requestId: cancel.requestId,
  });
}

export function normalizeAcceleratorBrokerLedgerRecord(raw) {
  const value = requireObject(raw, 'accelerator broker ledger record');
  onlyKeys(value, new Set(['protocol', 'revision', 'request', 'requestDigest', 'observation', 'cancelIntent']), 'accelerator broker ledger record');
  if (value.protocol !== ACCELERATOR_BROKER_LEDGER_PROTOCOL) throw new TypeError('accelerator broker ledger protocol is unsupported');
  const request = normalizeAcceleratorBrokerExecuteRequest(value.request);
  const requestDigest = digestAcceleratorBrokerExecuteRequest(request);
  if (value.requestDigest !== requestDigest) throw new TypeError('accelerator broker ledger request digest does not match request');
  const observation = normalizeAcceleratorBrokerObservation(value.observation);
  assertObservationOwnsRequest(observation, request, requestDigest);
  const cancelIntent = normalizeCancelIntent(value.cancelIntent, request, requestDigest);
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_LEDGER_PROTOCOL,
    revision: revision(value.revision),
    request,
    requestDigest,
    observation,
    cancelIntent,
  });
}

export function assertAcceleratorBrokerLedgerRecordTransition(rawPrevious, rawNext) {
  const previous = normalizeAcceleratorBrokerLedgerRecord(rawPrevious);
  const next = normalizeAcceleratorBrokerLedgerRecord(rawNext);
  if (next.revision !== previous.revision + 1) throw new TypeError('accelerator broker ledger record revision transition is invalid');
  if (next.requestDigest !== previous.requestDigest || JSON.stringify(next.request) !== JSON.stringify(previous.request)) {
    throw new TypeError('accelerator broker ledger record request changed across revisions');
  }
  assertAcceleratorBrokerObservationTransition(previous.observation, next.observation);
  if (previous.cancelIntent != null) {
    if (next.cancelIntent == null || JSON.stringify(previous.cancelIntent) !== JSON.stringify(next.cancelIntent)) {
      throw new TypeError('accelerator broker ledger cancellation intent changed across revisions');
    }
  }
  return next;
}

export function createAcceleratorBrokerLedgerRecord({ request: rawRequest, observation: rawObservation }) {
  const request = normalizeAcceleratorBrokerExecuteRequest(rawRequest);
  const requestDigest = digestAcceleratorBrokerExecuteRequest(request);
  const observation = normalizeAcceleratorBrokerObservation(rawObservation);
  assertObservationOwnsRequest(observation, request, requestDigest);
  return normalizeAcceleratorBrokerLedgerRecord({
    protocol: ACCELERATOR_BROKER_LEDGER_PROTOCOL,
    revision: 1,
    request,
    requestDigest,
    observation,
    cancelIntent: null,
  });
}

export function advanceAcceleratorBrokerLedgerRecord(rawCurrent, { observation: rawObservation = null, cancel: rawCancel = null } = {}) {
  const current = normalizeAcceleratorBrokerLedgerRecord(rawCurrent);
  if (current.revision >= MAX_REVISION) throw new Error('accelerator broker ledger revision is exhausted');
  let observation = current.observation;
  if (rawObservation != null) observation = assertAcceleratorBrokerObservationTransition(current.observation, rawObservation);
  let cancelIntent = current.cancelIntent;
  if (rawCancel != null) {
    const cancel = normalizeAcceleratorBrokerCancelRequest(rawCancel);
    const digest = digestAcceleratorBrokerCancelRequest(cancel);
    const next = normalizeCancelIntent({ request: cancel, digest }, current.request, current.requestDigest);
    if (cancelIntent != null && (cancelIntent.digest !== next.digest || cancelIntent.request.cancelId !== next.request.cancelId)) {
      throw new Error('accelerator broker ledger cancellation intent is immutable');
    }
    cancelIntent = next;
  }
  return normalizeAcceleratorBrokerLedgerRecord({
    protocol: ACCELERATOR_BROKER_LEDGER_PROTOCOL,
    revision: current.revision + 1,
    request: current.request,
    requestDigest: current.requestDigest,
    observation,
    cancelIntent,
  });
}
