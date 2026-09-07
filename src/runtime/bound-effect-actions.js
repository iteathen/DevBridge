const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function identity(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function input(raw) {
  const value = exactObject(raw, new Set(['protocol', 'mode', 'item', 'planDigest', 'effect']), 'effect action input');
  const effect = exactObject(value.effect, new Set(['identity', 'bytes', 'terminal']), 'effect action descriptor');
  if (!Number.isSafeInteger(effect.bytes) || effect.bytes < 0 || typeof effect.terminal !== 'boolean') {
    throw new TypeError('effect action descriptor is invalid');
  }
  if (typeof value.planDigest !== 'string' || !SHA256.test(value.planDigest)) throw new TypeError('effect action plan digest is invalid');
  return Object.freeze({
    protocol: text(value.protocol, 'effect action protocol'),
    mode: identity(value.mode, 'effect action mode'),
    item: identity(value.item, 'effect action item'),
    planDigest: value.planDigest,
    effect: Object.freeze({ identity: identity(effect.identity, 'effect action identity'), bytes: effect.bytes, terminal: effect.terminal }),
  });
}

function exactJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('bound effect value must be an object');
  const seen = new WeakSet();
  let nodes = 0;
  function visit(selected, depth) {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) throw new Error('JSON data exceeds its bound');
    if (selected === null || typeof selected === 'string' || typeof selected === 'boolean') return;
    if (typeof selected === 'number') {
      if (!Number.isFinite(selected)) throw new Error('number is not finite');
      return;
    }
    if (typeof selected !== 'object' || seen.has(selected)) throw new Error('value is not JSON data');
    seen.add(selected);
    if (Array.isArray(selected)) {
      for (const entry of selected) visit(entry, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(selected);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('object prototype is not JSON data');
      for (const entry of Object.values(selected)) visit(entry, depth + 1);
    }
    seen.delete(selected);
  }
  try {
    visit(value, 0);
    const clone = structuredClone(value);
    const encoded = JSON.stringify(clone);
    if (encoded.length > 32 * 1024 * 1024) throw new Error('JSON data exceeds its byte bound');
    return Object.freeze(clone);
  } catch (error) {
    throw new TypeError('bound effect value must be exact JSON data', { cause: error });
  }
}

function binding(raw, expected) {
  const value = exactObject(raw, new Set(['protocol', 'mode', 'item', 'identity', 'planDigest', 'bound', 'value']), 'effect action binding');
  if (value.protocol !== expected.protocol || value.mode !== expected.mode || value.item !== expected.item
      || value.identity !== expected.effect.identity || value.planDigest !== expected.planDigest || value.bound !== true) {
    throw new TypeError('effect action binding did not preserve exact input');
  }
  return Object.freeze({
    protocol: value.protocol,
    mode: value.mode,
    item: value.item,
    identity: value.identity,
    planDigest: value.planDigest,
    bound: true,
    value: exactJson(value.value),
  });
}

function publicBinding(value) {
  return Object.freeze({
    protocol: value.protocol,
    mode: value.mode,
    item: value.item,
    identity: value.identity,
    planDigest: value.planDigest,
    bound: true,
  });
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

export function createBoundEffectActions({ catalog, actions } = {}) {
  const selectedCatalog = requirePort(catalog, ['bind', 'load', 'retire'], 'effect catalog');
  const selectedActions = requirePort(actions, ['observe', 'remove'], 'effect actions');

  return Object.freeze({
    async bind(raw) {
      const selected = input(raw);
      return publicBinding(binding(await selectedCatalog.bind(selected), selected));
    },
    async observe(raw) {
      const selected = input(raw);
      const bound = binding(await selectedCatalog.load(selected), selected);
      const observed = exactObject(await selectedActions.observe(bound.value), new Set(['identity', 'state', 'retryable']), 'effect action observation');
      if (!['present', 'absent', 'ambiguous'].includes(observed.state) || typeof observed.retryable !== 'boolean') {
        throw new TypeError('effect action observation is invalid');
      }
      return Object.freeze({ identity: selected.effect.identity, state: observed.state, retryable: observed.retryable });
    },
    async remove(raw) {
      const selected = input(raw);
      const bound = binding(await selectedCatalog.load(selected), selected);
      return selectedActions.remove(bound.value);
    },
    async retire(raw) {
      const selected = input(raw);
      const retired = exactObject(await selectedCatalog.retire(selected), new Set(['identity', 'retired']), 'effect action retirement');
      if (retired.identity !== selected.effect.identity || retired.retired !== true) {
        throw new TypeError('effect action retirement did not preserve exact input');
      }
      return Object.freeze({ identity: retired.identity, retired: true });
    },
  });
}
