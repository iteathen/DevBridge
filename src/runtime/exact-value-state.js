import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function identity(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function exactValue(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function operation(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('value-state operation identity is invalid');
  return value;
}

function stateItem(raw, name, protocol, controlIdentity) {
  const value = exactObject(raw, new Set(['identity', 'provenance', 'value']), name);
  const selectedIdentity = identity(value.identity, `${name}.identity`);
  if (!['created', 'adopted'].includes(value.provenance)) throw new TypeError(`${name}.provenance is invalid`);
  const selectedValue = exactValue(value.value, `${name}.value`);
  if (selectedValue.protocol !== protocol || !['control', 'reserved', 'complete'].includes(selectedValue.phase)) {
    throw new TypeError(`${name}.value is invalid`);
  }
  if (selectedValue.phase === 'control') {
    exactObject(selectedValue, new Set(['protocol', 'phase', 'protected']), `${name}.value`);
    if (selectedIdentity !== controlIdentity || selectedValue.protected !== true) throw new TypeError(`${name}.value is invalid`);
  } else {
    exactObject(selectedValue, new Set(['protocol', 'phase', 'operation', 'request', 'value']), `${name}.value`);
    operation(selectedValue.operation);
    exactValue(selectedValue.request, `${name}.value.request`);
    if (selectedValue.phase === 'reserved' && selectedValue.value != null) throw new TypeError(`${name}.value is invalid`);
    if (selectedValue.phase === 'complete') exactValue(selectedValue.value, `${name}.value.value`);
  }
  return value;
}

function byIdentity(snapshot, selectedIdentity) {
  return snapshot.items.find((entry) => entry.identity === selectedIdentity) ?? null;
}

function control(protocol, controlIdentity, provenance) {
  return Object.freeze({
    identity: controlIdentity,
    provenance,
    value: Object.freeze({ protocol, phase: 'control', protected: true }),
  });
}

function reserved({ protocol, selectedIdentity, provenance, operationId, request }) {
  return Object.freeze({
    identity: selectedIdentity,
    provenance,
    value: Object.freeze({
      protocol,
      phase: 'reserved',
      operation: operationId,
      request,
      value: null,
    }),
  });
}

function completed(reservation, value) {
  return Object.freeze({
    identity: reservation.identity,
    provenance: reservation.provenance,
    value: Object.freeze({
      ...reservation.value,
      phase: 'complete',
      value,
    }),
  });
}

export function createExactValueState({
  collection,
  protocol,
  controlIdentity: rawControlIdentity = 'control',
  identifier = randomUUID,
} = {}) {
  if (!collection || typeof collection.read !== 'function' || typeof collection.apply !== 'function') {
    throw new TypeError('value-state collection contract is incomplete');
  }
  if (typeof protocol !== 'string' || protocol.length < 1 || protocol.length > 256) {
    throw new TypeError('value-state protocol is invalid');
  }
  const controlIdentity = identity(rawControlIdentity, 'value-state control identity');
  if (typeof identifier !== 'function') throw new TypeError('value-state identity dependency is invalid');

  async function open() {
    let current = await collection.read();
    const existing = byIdentity(current, controlIdentity);
    if (existing) {
      stateItem(existing, 'value-state control item', protocol, controlIdentity);
      if (existing.value.phase !== 'control') fail('value-state control item conflicts with another value');
      return current;
    }
    const anchor = control(protocol, controlIdentity, current.revision == null ? 'created' : 'adopted');
    current = await collection.apply({ changes: [{ identity: controlIdentity, before: null, after: anchor }] });
    stateItem(byIdentity(current, controlIdentity), 'value-state control item', protocol, controlIdentity);
    return current;
  }

  async function read(selectedIdentity) {
    identity(selectedIdentity, 'value-state item identity');
    const current = await open();
    const existing = byIdentity(current, selectedIdentity);
    return existing == null ? null : stateItem(existing, 'value-state item', protocol, controlIdentity);
  }

  async function reserve(raw) {
    const value = exactObject(raw, new Set(['identity', 'provenance', 'request', 'operation']), 'value-state reservation');
    const selectedIdentity = identity(value.identity, 'value-state reservation.identity');
    if (selectedIdentity === controlIdentity) throw new TypeError('value-state reservation cannot replace control state');
    if (!['created', 'adopted'].includes(value.provenance)) throw new TypeError('value-state reservation.provenance is invalid');
    const request = exactValue(value.request, 'value-state reservation.request');
    const current = await open();
    const before = byIdentity(current, selectedIdentity);
    if (before) {
      stateItem(before, 'value-state reservation current item', protocol, controlIdentity);
      if (before.value.phase === 'reserved') {
        if (before.provenance === value.provenance && isDeepStrictEqual(before.value.request, request)
            && (value.operation == null || before.value.operation === value.operation)) return before;
        fail(`value-state item ${selectedIdentity} has another pending operation`);
      }
    }
    const operationId = operation(value.operation ?? identifier());
    const after = reserved({ protocol, selectedIdentity, provenance: value.provenance, operationId, request });
    const accepted = await collection.apply({ changes: [{ identity: selectedIdentity, before, after }] });
    return stateItem(byIdentity(accepted, selectedIdentity), 'value-state reservation accepted item', protocol, controlIdentity);
  }

  async function complete(raw) {
    const input = exactObject(raw, new Set(['reservation', 'value']), 'value-state completion');
    const reservation = stateItem(input.reservation, 'value-state completion.reservation', protocol, controlIdentity);
    if (reservation.identity === controlIdentity || reservation.value.phase !== 'reserved') {
      throw new TypeError('value-state completion reservation is invalid');
    }
    const value = exactValue(input.value, 'value-state completion.value');
    const after = completed(reservation, value);
    const accepted = await collection.apply({ changes: [{ identity: reservation.identity, before: reservation, after }] });
    return stateItem(byIdentity(accepted, reservation.identity), 'value-state completion accepted item', protocol, controlIdentity);
  }

  async function record(raw) {
    const value = exactObject(raw, new Set(['identity', 'provenance', 'request', 'value', 'operation']), 'value-state record');
    const current = await read(value.identity);
    if (current?.value.phase === 'complete' && current.provenance === value.provenance
        && isDeepStrictEqual(current.value.request, value.request)
        && isDeepStrictEqual(current.value.value, value.value)) return current;
    const reservation = await reserve({
      identity: value.identity,
      provenance: value.provenance,
      request: value.request,
      operation: value.operation,
    });
    return complete({ reservation, value: value.value });
  }

  async function replace(raw) {
    const input = exactObject(raw, new Set(['item', 'value']), 'value-state replacement');
    const item = stateItem(input.item, 'value-state replacement.item', protocol, controlIdentity);
    if (item.identity === controlIdentity || item.value.phase !== 'complete') {
      throw new TypeError('value-state replacement requires a completed non-control item');
    }
    const value = exactValue(input.value, 'value-state replacement.value');
    const nextOperation = operation(identifier());
    if (nextOperation === item.value.operation) throw new Error('value-state replacement requires a new operation identity');
    const after = completed({ ...item, value: { ...item.value, operation: nextOperation } }, value);
    const accepted = await collection.apply({ changes: [{ identity: item.identity, before: item, after }] });
    return stateItem(byIdentity(accepted, item.identity), 'value-state replacement accepted item', protocol, controlIdentity);
  }

  async function clear(raw) {
    const value = exactObject(raw, new Set(['item']), 'value-state clearing');
    const item = stateItem(value.item, 'value-state clearing.item', protocol, controlIdentity);
    if (item.identity === controlIdentity || item.value.phase !== 'reserved') {
      throw new TypeError('value-state clearing item is invalid');
    }
    return collection.apply({ changes: [{ identity: item.identity, before: item, after: null }] });
  }

  return Object.freeze({ open, read, reserve, complete, record, replace, clear });
}
