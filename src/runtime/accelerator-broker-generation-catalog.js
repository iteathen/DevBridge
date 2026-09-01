import { isAcceleratorBrokerTerminalState } from './accelerator-broker-protocol.js';
import {
  acceleratorBrokerLedgerKey,
  normalizeAcceleratorBrokerLedgerRecord,
} from './accelerator-broker-ledger.js';

export const ACCELERATOR_BROKER_GENERATION_OBSERVATION_PROTOCOL = 'devbridge/accelerator-broker-generation-observation-v1';

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

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

export function normalizeAcceleratorBrokerGenerationSelector(raw) {
  const value = requireObject(raw, 'accelerator broker generation selector');
  onlyKeys(value, new Set(['sessionIdentity', 'sessionGeneration']), 'accelerator broker generation selector');
  return Object.freeze({
    sessionIdentity: safeId(value.sessionIdentity, 'accelerator broker generation selector.sessionIdentity'),
    sessionGeneration: safeId(value.sessionGeneration, 'accelerator broker generation selector.sessionGeneration'),
  });
}

export function normalizeAcceleratorBrokerGenerationObservation(raw) {
  const value = requireObject(raw, 'accelerator broker generation observation');
  onlyKeys(value, new Set([
    'protocol', 'session', 'recordCount', 'terminalCount', 'nonterminalCount', 'quiescent',
  ]), 'accelerator broker generation observation');
  if (value.protocol !== ACCELERATOR_BROKER_GENERATION_OBSERVATION_PROTOCOL) {
    throw new TypeError('accelerator broker generation observation protocol is unsupported');
  }
  const session = requireObject(value.session, 'accelerator broker generation observation.session');
  onlyKeys(session, new Set(['identity', 'generation']), 'accelerator broker generation observation.session');
  const recordCount = count(value.recordCount, 'accelerator broker generation observation.recordCount');
  const terminalCount = count(value.terminalCount, 'accelerator broker generation observation.terminalCount');
  const nonterminalCount = count(value.nonterminalCount, 'accelerator broker generation observation.nonterminalCount');
  if (terminalCount + nonterminalCount !== recordCount) {
    throw new TypeError('accelerator broker generation observation counts are inconsistent');
  }
  if (typeof value.quiescent !== 'boolean' || value.quiescent !== (nonterminalCount === 0)) {
    throw new TypeError('accelerator broker generation observation quiescence is inconsistent');
  }
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_GENERATION_OBSERVATION_PROTOCOL,
    session: Object.freeze({
      identity: safeId(session.identity, 'accelerator broker generation observation.session.identity'),
      generation: safeId(session.generation, 'accelerator broker generation observation.session.generation'),
    }),
    recordCount,
    terminalCount,
    nonterminalCount,
    quiescent: value.quiescent,
  });
}

export function createAcceleratorBrokerGenerationObservation(rawSelector, rawRecords) {
  const selector = normalizeAcceleratorBrokerGenerationSelector(rawSelector);
  if (!Array.isArray(rawRecords)) throw new TypeError('accelerator broker generation records must be an array');
  const seen = new Set();
  let recordCount = 0;
  let terminalCount = 0;
  let nonterminalCount = 0;

  for (const rawRecord of rawRecords) {
    const record = normalizeAcceleratorBrokerLedgerRecord(rawRecord);
    const key = acceleratorBrokerLedgerKey(record.request);
    const encodedKey = JSON.stringify(key);
    if (seen.has(encodedKey)) throw new TypeError('accelerator broker generation records contain a duplicate ledger key');
    seen.add(encodedKey);
    if (key.sessionIdentity !== selector.sessionIdentity || key.sessionGeneration !== selector.sessionGeneration) continue;
    recordCount += 1;
    if (isAcceleratorBrokerTerminalState(record.observation.state)) terminalCount += 1;
    else nonterminalCount += 1;
  }

  return normalizeAcceleratorBrokerGenerationObservation({
    protocol: ACCELERATOR_BROKER_GENERATION_OBSERVATION_PROTOCOL,
    session: { identity: selector.sessionIdentity, generation: selector.sessionGeneration },
    recordCount,
    terminalCount,
    nonterminalCount,
    quiescent: nonterminalCount === 0,
  });
}
