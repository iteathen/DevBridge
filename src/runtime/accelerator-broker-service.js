import { TextDecoder } from 'node:util';
import {
  normalizeAcceleratorBrokerCancelRequest,
  normalizeAcceleratorBrokerExecuteRequest,
  normalizeAcceleratorBrokerObservation,
} from './accelerator-broker-protocol.js';

export const ACCELERATOR_BROKER_SERVICE_PROTOCOL = 'devbridge/accelerator-broker-service-v1';
export const ACCELERATOR_BROKER_SERVICE_KIND = Object.freeze({
  EXECUTE: 'execute',
  OBSERVE: 'observe',
  CANCEL: 'cancel',
});
export const ACCELERATOR_BROKER_SERVICE_OUTCOME = Object.freeze({
  OBSERVATION: 'observation',
  ABSENT: 'absent',
});
export const ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES = 128 * 1024;

const KINDS = new Set(Object.values(ACCELERATOR_BROKER_SERVICE_KIND));
const OUTCOMES = new Set(Object.values(ACCELERATOR_BROKER_SERVICE_OUTCOME));
const FRAME_TERMINATOR = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function normalizeKind(value) {
  if (typeof value !== 'string' || !KINDS.has(value)) throw new TypeError('accelerator broker service kind is unsupported');
  return value;
}

function normalizeBody(kind, raw) {
  if (kind === ACCELERATOR_BROKER_SERVICE_KIND.CANCEL) return normalizeAcceleratorBrokerCancelRequest(raw);
  return normalizeAcceleratorBrokerExecuteRequest(raw);
}

export function normalizeAcceleratorBrokerServiceRequest(raw) {
  const value = requireObject(raw, 'accelerator broker service request');
  onlyKeys(value, new Set(['protocol', 'kind', 'body']), 'accelerator broker service request');
  if (value.protocol !== ACCELERATOR_BROKER_SERVICE_PROTOCOL) throw new TypeError('accelerator broker service protocol is unsupported');
  const kind = normalizeKind(value.kind);
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
    kind,
    body: normalizeBody(kind, value.body),
  });
}

export function normalizeAcceleratorBrokerServiceResponse(raw) {
  const value = requireObject(raw, 'accelerator broker service response');
  onlyKeys(value, new Set(['protocol', 'kind', 'outcome', 'observation']), 'accelerator broker service response');
  if (value.protocol !== ACCELERATOR_BROKER_SERVICE_PROTOCOL) throw new TypeError('accelerator broker service protocol is unsupported');
  const kind = normalizeKind(value.kind);
  if (typeof value.outcome !== 'string' || !OUTCOMES.has(value.outcome)) {
    throw new TypeError('accelerator broker service response outcome is unsupported');
  }
  if (value.outcome === ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT) {
    if (kind === ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE) {
      throw new TypeError('accelerator broker service execute response cannot be absent');
    }
    if (value.observation !== null) throw new TypeError('accelerator broker service absent response must contain null observation');
    return Object.freeze({
      protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
      kind,
      outcome: ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT,
      observation: null,
    });
  }
  if (value.observation == null) throw new TypeError('accelerator broker service observation response is missing observation');
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
    kind,
    outcome: ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION,
    observation: normalizeAcceleratorBrokerObservation(value.observation),
  });
}

function frameBytes(raw, name) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  throw new TypeError(`${name} must be bytes`);
}

function encodeFrame(value, name) {
  let text;
  try { text = JSON.stringify(value); }
  catch { throw new TypeError(`${name} could not be encoded`); }
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 1 || payload.length > ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES) {
    throw new TypeError(`${name} exceeds the service frame bound`);
  }
  return Buffer.concat([payload, Buffer.from([FRAME_TERMINATOR])]);
}

function decodeFrame(raw, name) {
  const wire = frameBytes(raw, name);
  if (wire.length < 2 || wire.length > ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES + 1) {
    throw new TypeError(`${name} exceeds the service frame bound`);
  }
  const terminator = wire.indexOf(FRAME_TERMINATOR);
  if (terminator !== wire.length - 1) throw new TypeError(`${name} must contain exactly one terminated frame`);
  const payload = wire.subarray(0, terminator);
  if (payload.length < 1 || payload.length > ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES) {
    throw new TypeError(`${name} exceeds the service frame bound`);
  }
  let text;
  try { text = utf8.decode(payload); }
  catch { throw new TypeError(`${name} is not valid UTF-8`); }
  try { return JSON.parse(text); }
  catch { throw new TypeError(`${name} is not valid JSON`); }
}

export function encodeAcceleratorBrokerServiceRequestFrame(raw) {
  return encodeFrame(normalizeAcceleratorBrokerServiceRequest(raw), 'accelerator broker service request frame');
}

export function decodeAcceleratorBrokerServiceRequestFrame(raw) {
  return normalizeAcceleratorBrokerServiceRequest(decodeFrame(raw, 'accelerator broker service request frame'));
}

export function encodeAcceleratorBrokerServiceResponseFrame(raw) {
  return encodeFrame(normalizeAcceleratorBrokerServiceResponse(raw), 'accelerator broker service response frame');
}

export function decodeAcceleratorBrokerServiceResponseFrame(raw) {
  return normalizeAcceleratorBrokerServiceResponse(decodeFrame(raw, 'accelerator broker service response frame'));
}

function assertBroker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ['execute', 'observe', 'cancel'].some((method) => typeof value[method] !== 'function')) {
    throw new TypeError('accelerator broker service broker contract is incomplete');
  }
  return value;
}

export class AcceleratorBrokerService {
  #broker;

  constructor({ broker } = {}) {
    this.#broker = assertBroker(broker);
  }

  async handle(rawRequest) {
    const request = normalizeAcceleratorBrokerServiceRequest(rawRequest);
    let rawObservation;
    try { rawObservation = await this.#broker[request.kind](request.body); }
    catch { throw new Error('accelerator broker service operation is unavailable'); }
    if (rawObservation == null) {
      if (request.kind === ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE) {
        throw new Error('accelerator broker service operation is unavailable');
      }
      return normalizeAcceleratorBrokerServiceResponse({
        protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
        kind: request.kind,
        outcome: ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT,
        observation: null,
      });
    }
    try {
      return normalizeAcceleratorBrokerServiceResponse({
        protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
        kind: request.kind,
        outcome: ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION,
        observation: rawObservation,
      });
    } catch {
      throw new Error('accelerator broker service operation is unavailable');
    }
  }
}

export async function handleAcceleratorBrokerServiceFrame(service, rawFrame) {
  if (!service || typeof service.handle !== 'function') throw new TypeError('accelerator broker service handler is required');
  const request = decodeAcceleratorBrokerServiceRequestFrame(rawFrame);
  const response = await service.handle(request);
  return encodeAcceleratorBrokerServiceResponseFrame(response);
}
