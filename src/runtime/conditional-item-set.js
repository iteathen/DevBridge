const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const MAX_ITEMS = 4_096;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ATTEMPTS = 16;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;

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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function freeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freeze(entry);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
  }
  return Object.freeze(value);
}

function exactJson(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  const seen = new WeakSet();
  let nodes = 0;
  function visit(value, depth) {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) fail(`${name} exceeds its structural bound`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(`${name} contains a non-finite number`);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) fail(`${name} is not exact JSON data`);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail(`${name} is not exact JSON data`);
    seen.add(value);
    for (const entry of Array.isArray(value) ? value : Object.values(value)) visit(entry, depth + 1);
    seen.delete(value);
  }
  try {
    visit(raw, 0);
    const value = canonical(structuredClone(raw));
    const encoded = JSON.stringify(value);
    if (encoded == null || Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) fail(`${name} exceeds its byte bound`);
    return freeze(value);
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.startsWith(name)) throw error;
    throw new TypeError(`${name} must be bounded exact JSON data`, { cause: error });
  }
}

function item(raw, name) {
  const value = exactJson(raw, name);
  return Object.freeze({ ...value, identity: identity(value.identity, `${name}.identity`) });
}

function items(raw, name) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw new TypeError(`${name} is invalid`);
  const selected = raw.map((value, index) => item(value, `${name}[${index}]`))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  if (new Set(selected.map((value) => value.identity)).size !== selected.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(selected);
}

function revision(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function snapshot(raw, name) {
  const value = exactObject(raw, new Set(['revision', 'items']), name);
  const selectedRevision = revision(value.revision, `${name}.revision`);
  const selectedItems = items(value.items, `${name}.items`);
  if ((selectedRevision == null) !== (selectedItems.length === 0)) throw new TypeError(`${name} empty state is invalid`);
  return Object.freeze({ revision: selectedRevision, items: selectedItems });
}

function change(raw, index) {
  const value = exactObject(raw, new Set(['identity', 'before', 'after']), `conditional item change ${index}`);
  const selectedIdentity = identity(value.identity, `conditional item change ${index}.identity`);
  const before = value.before == null ? null : item(value.before, `conditional item change ${index}.before`);
  const after = value.after == null ? null : item(value.after, `conditional item change ${index}.after`);
  if (before?.identity !== selectedIdentity && before != null) throw new TypeError(`conditional item change ${index}.before identity changed`);
  if (after?.identity !== selectedIdentity && after != null) throw new TypeError(`conditional item change ${index}.after identity changed`);
  if (before == null && after == null) throw new TypeError(`conditional item change ${index} has no transition`);
  return Object.freeze({ identity: selectedIdentity, before, after });
}

function changes(raw) {
  const value = exactObject(raw, new Set(['changes']), 'conditional item change request');
  if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > MAX_ITEMS) {
    throw new TypeError('conditional item changes are invalid');
  }
  const selected = value.changes.map(change).sort((left, right) => left.identity.localeCompare(right.identity));
  if (new Set(selected.map((entry) => entry.identity)).size !== selected.length) {
    throw new TypeError('conditional item changes contain duplicates');
  }
  return Object.freeze(selected);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexed(raw) {
  return new Map(raw.map((entry) => [entry.identity, entry]));
}

function result(raw) {
  const value = exactObject(raw, new Set(['accepted', 'snapshot']), 'conditional item comparison result');
  if (typeof value.accepted !== 'boolean') throw new TypeError('conditional item comparison result.accepted is invalid');
  return Object.freeze({ accepted: value.accepted, snapshot: snapshot(value.snapshot, 'conditional item comparison result.snapshot') });
}

export function createConditionalItemSet({ records, attempts = MAX_ATTEMPTS } = {}) {
  if (!records || typeof records.read !== 'function' || typeof records.compare !== 'function') {
    throw new TypeError('conditional item records contract is incomplete');
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new TypeError('conditional item attempt bound is invalid');
  }

  async function read() {
    return snapshot(await records.read(), 'conditional item snapshot');
  }

  async function apply(raw) {
    const selected = changes(raw);
    let current = await read();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const observed = indexed(current.items);
      if (selected.every((entry) => equal(observed.get(entry.identity) ?? null, entry.after))) return current;
      for (const entry of selected) {
        if (!equal(observed.get(entry.identity) ?? null, entry.before)) {
          fail(`conditional item ${entry.identity} changed outside its expected transition`);
        }
      }
      for (const entry of selected) {
        if (entry.after == null) observed.delete(entry.identity);
        else observed.set(entry.identity, entry.after);
      }
      const nextItems = [...observed.values()].sort((left, right) => left.identity.localeCompare(right.identity));
      if (nextItems.length === 0) fail('conditional item set cannot become empty');
      const compared = result(await records.compare(Object.freeze({ revision: current.revision, items: nextItems })));
      if (compared.accepted) {
        if (!equal(compared.snapshot.items, nextItems)) fail('conditional item accepted snapshot differs from its proposal');
        return compared.snapshot;
      }
      current = compared.snapshot;
    }
    fail('conditional item set changed continuously during bounded acceptance');
  }

  return Object.freeze({ read, apply });
}
