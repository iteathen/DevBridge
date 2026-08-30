const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const GENERATION = /^generation-[a-f0-9]{64}$/u;
const PROVENANCE = new Set(['created', 'adopted']);
const PHASES = new Set(['control', 'reserved', 'complete']);
const MAX_ITEMS = 4096;

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function identity(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function identities(raw, name) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw new TypeError(`${name} is invalid`);
  const values = raw.map((member, index) => identity(member, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

function relationship(raw, name) {
  const value = exactObject(raw, new Set(['protections', 'references', 'after']), name);
  return Object.freeze({
    protections: identities(value.protections, `${name}.protections`),
    references: identities(value.references, `${name}.references`),
    after: identities(value.after, `${name}.after`),
  });
}

function request(raw, expectedIdentity) {
  const value = exactObject(raw, new Set(['identity']), 'receipt-value observation request');
  if (value.identity !== expectedIdentity) throw new TypeError('receipt-value observation identity changed');
}

function receiptItem(raw, index) {
  const item = exactObject(raw, new Set(['identity', 'provenance', 'value']), `receipt-value item ${index}`);
  const selectedIdentity = identity(item.identity, `receipt-value item ${index}.identity`);
  if (!PROVENANCE.has(item.provenance)) throw new TypeError(`receipt-value item ${index}.provenance is invalid`);
  if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value)) {
    throw new TypeError(`receipt-value item ${index}.value is invalid`);
  }
  return Object.freeze({ identity: selectedIdentity, provenance: item.provenance, value: item.value });
}

function stateValue(item, valueProtocol, controlIdentity, name) {
  const value = exactObject(item.value, new Set(['protocol', 'phase', 'protected', 'operation', 'request', 'value']), name);
  if (value.protocol !== valueProtocol || !PHASES.has(value.phase)) throw new TypeError(`${name} is invalid`);
  if (value.phase === 'control') {
    if (item.identity !== controlIdentity || value.protected !== true || value.operation != null
        || value.request != null || value.value != null) {
      throw new TypeError(`${name} is invalid`);
    }
  } else {
    if (item.identity === controlIdentity || value.protected != null || typeof value.operation !== 'string'
        || !value.request || typeof value.request !== 'object' || Array.isArray(value.request)) {
      throw new TypeError(`${name} is invalid`);
    }
    if (value.phase === 'reserved' && value.value != null) throw new TypeError(`${name} is invalid`);
    if (value.phase === 'complete' && (!value.value || typeof value.value !== 'object' || Array.isArray(value.value))) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  return Object.freeze({ ...value });
}

function receipt(raw, collectionProtocol, valueProtocol, controlIdentity) {
  if (raw == null) return null;
  const value = exactObject(
    raw,
    new Set(['protocol', 'revision', 'epoch', 'previousDigest', 'generation', 'items']),
    'receipt-value record',
  );
  if (value.protocol !== collectionProtocol || !GENERATION.test(value.generation)
      || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_ITEMS) {
    throw new TypeError('receipt-value record is invalid');
  }
  const items = value.items.map((member, index) => receiptItem(member, index));
  if (new Set(items.map((member) => member.identity)).size !== items.length) {
    throw new TypeError('receipt-value record contains duplicate identities');
  }
  const control = items.find((member) => member.identity === controlIdentity);
  if (!control || stateValue(control, valueProtocol, controlIdentity, 'receipt-value control').phase !== 'control') {
    throw new Error('receipt-value control is unavailable');
  }
  return Object.freeze({ generation: value.generation, items: Object.freeze(items) });
}

export function createReceiptValueSource({
  identity: rawIdentity,
  collection,
  collectionProtocol,
  valueProtocol,
  controlIdentity,
  select,
  relate,
} = {}) {
  const selectedIdentity = identity(rawIdentity, 'receipt-value identity');
  if (!collection || typeof collection.read !== 'function') throw new TypeError('receipt-value collection contract is incomplete');
  if (typeof collectionProtocol !== 'string' || collectionProtocol.length === 0
      || typeof valueProtocol !== 'string' || valueProtocol.length === 0) {
    throw new TypeError('receipt-value protocol configuration is invalid');
  }
  const selectedControl = identity(controlIdentity, 'receipt-value control identity');
  if (typeof select !== 'function' || typeof relate !== 'function') {
    throw new TypeError('receipt-value projection contract is incomplete');
  }

  return Object.freeze({
    async observe(rawRequest) {
      request(rawRequest, selectedIdentity);
      const current = receipt(await collection.read(), collectionProtocol, valueProtocol, selectedControl);
      if (!current) {
        return Object.freeze({
          identity: selectedIdentity,
          generation: 'generation-absent',
          complete: false,
          items: Object.freeze([]),
        });
      }
      const selected = current.items.filter((member) => {
        if (member.identity === selectedControl) return false;
        const included = select(member.identity);
        if (typeof included !== 'boolean') throw new TypeError('receipt-value selection result is invalid');
        return included;
      }).map((member, index) => Object.freeze({
        ...member,
        value: stateValue(member, valueProtocol, selectedControl, `receipt-value selected item ${index}`),
      }));
      const completeItems = selected.filter((member) => member.value.phase === 'complete');
      const available = Object.freeze(completeItems.map((member) => member.identity).sort((left, right) => left.localeCompare(right)));
      const items = completeItems.map((member, index) => {
        const selectedRelationships = relationship(
          relate(Object.freeze({ identity: member.identity, available })),
          `receipt-value relationship ${index}`,
        );
        return Object.freeze({
          identity: member.identity,
          provenance: member.provenance,
          ...selectedRelationships,
          value: structuredClone(member.value.value),
        });
      }).sort((left, right) => left.identity.localeCompare(right.identity));
      return Object.freeze({
        identity: selectedIdentity,
        generation: current.generation,
        complete: selected.every((member) => member.value.phase === 'complete'),
        items: Object.freeze(items),
      });
    },
  });
}
