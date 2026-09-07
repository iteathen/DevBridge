const PROTOCOL = 'devbridge/protected-operation-dispatch-v1';
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${name} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key) || descriptors[key].enumerable !== true || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  return value;
}

function result({ completed, output, reason }) {
  return Object.freeze({ protocol: PROTOCOL, completed, output, reason });
}

function unavailable(reason) {
  return result({ completed: false, output: null, reason });
}

function encodedChunk(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError('protected operation input chunk is invalid');
}

async function boundedInput(value) {
  const chunks = [];
  let size = 0;
  const append = (chunk) => {
    const bytes = encodedChunk(chunk);
    size += bytes.byteLength;
    if (size > MAX_INPUT_BYTES) throw new RangeError('protected operation input is too large');
    chunks.push(bytes);
  };
  if (typeof value === 'string' || value instanceof Uint8Array) append(value);
  else {
    if (!value || typeof value[Symbol.asyncIterator] !== 'function') throw new TypeError('protected operation input is invalid');
    for await (const chunk of value) append(chunk);
  }
  if (size < 2) throw new TypeError('protected operation input is empty');
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateOutput(value, state = { seen: new Set(), entries: 0 }, depth = 0) {
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('protected operation output is invalid');
    return;
  }
  if (typeof value === 'string') {
    if (value.includes('\0') || new TextEncoder().encode(value).byteLength > MAX_OUTPUT_BYTES) {
      throw new TypeError('protected operation output is invalid');
    }
    return;
  }
  if (!value || typeof value !== 'object' || depth > 16 || state.seen.has(value)) {
    throw new TypeError('protected operation output is invalid');
  }
  state.seen.add(value);
  if (!Array.isArray(value) && !plainObject(value)) throw new TypeError('protected operation output is invalid');
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError('protected operation output is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))
        || names.length !== keys.length + 1 || names.at(-1) !== 'length') {
      throw new TypeError('protected operation output is invalid');
    }
  } else if (Object.getOwnPropertyNames(value).length !== keys.length) {
    throw new TypeError('protected operation output is invalid');
  }
  state.entries += keys.length;
  if (state.entries > 1_024) throw new TypeError('protected operation output is invalid');
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true || key.includes('\0')
        || new TextEncoder().encode(key).byteLength > 1_024) {
      throw new TypeError('protected operation output is invalid');
    }
    validateOutput(descriptor.value, state, depth + 1);
  }
}

export async function dispatchProtectedOperation(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['input']), 'protected operation dispatch request');
  exactKeys(providedPorts, new Set(['perform']), 'protected operation dispatch ports');
  const perform = providedPorts.perform;
  if (typeof perform !== 'function') throw new TypeError('protected operation dispatch perform port is invalid');

  let subject;
  try {
    subject = JSON.parse(await boundedInput(value.input));
    if (!plainObject(subject)) throw new TypeError('protected operation subject is invalid');
  } catch {
    return unavailable('input-invalid');
  }

  let performed;
  try { performed = await perform(subject); }
  catch { return unavailable('operation-failed'); }
  if (!plainObject(performed)) return unavailable('output-invalid');

  let output;
  try {
    validateOutput(performed);
    output = JSON.stringify(performed);
  }
  catch { return unavailable('output-invalid'); }
  if (typeof output !== 'string' || new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) {
    return unavailable('output-invalid');
  }
  try {
    if (!plainObject(JSON.parse(output))) throw new TypeError('protected operation output is invalid');
  } catch {
    return unavailable('output-invalid');
  }
  return result({ completed: true, output, reason: null });
}

export { PROTOCOL as PROTECTED_OPERATION_DISPATCH_PROTOCOL };
