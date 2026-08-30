import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const OWNERSHIP_VALUE_PROTOCOL = 'devbridge/entry-ownership-value-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_IDENTITY = 'control';

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
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('ownership operation identity is invalid');
  return value;
}

function stateItem(raw, name) {
  const value = exactObject(raw, new Set(['identity', 'provenance', 'value']), name);
  const selectedIdentity = identity(value.identity, `${name}.identity`);
  if (!['created', 'adopted'].includes(value.provenance)) throw new TypeError(`${name}.provenance is invalid`);
  const selectedValue = exactValue(value.value, `${name}.value`);
  if (selectedValue.protocol !== OWNERSHIP_VALUE_PROTOCOL || !['control', 'reserved', 'complete'].includes(selectedValue.phase)) {
    throw new TypeError(`${name}.value is invalid`);
  }
  if (selectedValue.phase === 'control') {
    exactObject(selectedValue, new Set(['protocol', 'phase', 'protected']), `${name}.value`);
    if (selectedIdentity !== CONTROL_IDENTITY || selectedValue.protected !== true) throw new TypeError(`${name}.value is invalid`);
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

function control(provenance) {
  return Object.freeze({
    identity: CONTROL_IDENTITY,
    provenance,
    value: Object.freeze({ protocol: OWNERSHIP_VALUE_PROTOCOL, phase: 'control', protected: true }),
  });
}

function reserved({ selectedIdentity, provenance, operationId, request }) {
  return Object.freeze({
    identity: selectedIdentity,
    provenance,
    value: Object.freeze({
      protocol: OWNERSHIP_VALUE_PROTOCOL,
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

export function createOwnershipState({ collection, identifier = randomUUID } = {}) {
  if (!collection || typeof collection.read !== 'function' || typeof collection.apply !== 'function') {
    throw new TypeError('ownership collection contract is incomplete');
  }
  if (typeof identifier !== 'function') throw new TypeError('ownership identity dependency is invalid');

  async function open() {
    let current = await collection.read();
    const existing = byIdentity(current, CONTROL_IDENTITY);
    if (existing) {
      stateItem(existing, 'ownership control item');
      if (existing.value.phase !== 'control') fail('ownership control item conflicts with another value');
      return current;
    }
    const anchor = control(current.revision == null ? 'created' : 'adopted');
    current = await collection.apply({ changes: [{ identity: CONTROL_IDENTITY, before: null, after: anchor }] });
    stateItem(byIdentity(current, CONTROL_IDENTITY), 'ownership control item');
    return current;
  }

  async function read(selectedIdentity) {
    identity(selectedIdentity, 'ownership item identity');
    const current = await open();
    const existing = byIdentity(current, selectedIdentity);
    return existing == null ? null : stateItem(existing, 'ownership item');
  }

  async function reserve(raw) {
    const value = exactObject(raw, new Set(['identity', 'provenance', 'request', 'operation']), 'ownership reservation');
    const selectedIdentity = identity(value.identity, 'ownership reservation.identity');
    if (selectedIdentity === CONTROL_IDENTITY) throw new TypeError('ownership reservation cannot replace control state');
    if (!['created', 'adopted'].includes(value.provenance)) throw new TypeError('ownership reservation.provenance is invalid');
    const request = exactValue(value.request, 'ownership reservation.request');
    const current = await open();
    const before = byIdentity(current, selectedIdentity);
    if (before) {
      stateItem(before, 'ownership reservation current item');
      if (before.value.phase === 'reserved') {
        if (before.provenance === value.provenance && isDeepStrictEqual(before.value.request, request)
            && (value.operation == null || before.value.operation === value.operation)) return before;
        fail(`ownership item ${selectedIdentity} has another pending operation`);
      }
    }
    const operationId = operation(value.operation ?? identifier());
    const after = reserved({ selectedIdentity, provenance: value.provenance, operationId, request });
    const accepted = await collection.apply({ changes: [{ identity: selectedIdentity, before, after }] });
    return stateItem(byIdentity(accepted, selectedIdentity), 'ownership reservation accepted item');
  }

  async function complete(raw) {
    const input = exactObject(raw, new Set(['reservation', 'value']), 'ownership completion');
    const reservation = stateItem(input.reservation, 'ownership completion.reservation');
    if (reservation.identity === CONTROL_IDENTITY || reservation.value.phase !== 'reserved') {
      throw new TypeError('ownership completion reservation is invalid');
    }
    const value = exactValue(input.value, 'ownership completion.value');
    const after = completed(reservation, value);
    const accepted = await collection.apply({
      changes: [{ identity: reservation.identity, before: reservation, after }],
    });
    return stateItem(byIdentity(accepted, reservation.identity), 'ownership completion accepted item');
  }

  async function record(raw) {
    const value = exactObject(raw, new Set(['identity', 'provenance', 'request', 'value', 'operation']), 'ownership record');
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

  async function clear(raw) {
    const value = exactObject(raw, new Set(['item']), 'ownership clearing');
    const item = stateItem(value.item, 'ownership clearing.item');
    if (item.identity === CONTROL_IDENTITY || item.value.phase !== 'reserved') {
      throw new TypeError('ownership clearing item is invalid');
    }
    return collection.apply({ changes: [{ identity: item.identity, before: item, after: null }] });
  }

  return Object.freeze({ open, read, reserve, complete, record, clear });
}
