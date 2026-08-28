const PROTOCOL = 'devbridge/definition-reconciliation-v1';
const OBSERVATION_PROTOCOL = 'devbridge/definition-observation-v1';
const MAX_DEFINITION_BYTES = 64 * 1024;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function boundedDefinition(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_DEFINITION_BYTES) {
    throw new TypeError('definition is invalid');
  }
  return value;
}

function normalizeObservation(value) {
  exactKeys(value, new Set(['protocol', 'stored', 'current', 'persistent']), 'definition observation');
  if (value.protocol !== OBSERVATION_PROTOCOL) throw new TypeError('definition observation protocol is invalid');
  for (const name of ['stored', 'current', 'persistent']) {
    if (typeof value[name] !== 'boolean') throw new TypeError(`definition observation ${name} evidence is invalid`);
  }
  return Object.freeze({
    protocol: OBSERVATION_PROTOCOL,
    stored: value.stored,
    current: value.current,
    persistent: value.persistent,
  });
}

function normalizePorts(value) {
  exactKeys(value, new Set(['observe', 'publish', 'refresh', 'persist']), 'definition reconciliation ports');
  for (const name of ['observe', 'publish', 'refresh', 'persist']) {
    if (typeof value[name] !== 'function') throw new TypeError(`definition reconciliation ${name} port is invalid`);
  }
  return value;
}

function sameObservation(left, right, changed) {
  return left.stored === (changed.stored ?? right.stored)
    && left.current === (changed.current ?? right.current)
    && left.persistent === (changed.persistent ?? right.persistent);
}

async function observe(ports, request) {
  return normalizeObservation(await ports.observe(request));
}

async function apply(ports, name, request, before, expected) {
  if (await ports[name](request) !== true) throw new Error(`definition ${name} action evidence is invalid`);
  const after = await observe(ports, request);
  if (!sameObservation(after, before, expected)) throw new Error(`definition ${name} postcondition is inexact`);
  return after;
}

export async function reconcileDefinition(value) {
  exactKeys(value, new Set(['definition', 'ports']), 'definition reconciliation request');
  const definition = boundedDefinition(value.definition);
  const ports = normalizePorts(value.ports);
  const request = Object.freeze({ definition });
  let current = await observe(ports, request);
  let changed = false;

  if (!current.stored) {
    current = await apply(ports, 'publish', request, current, { stored: true });
    changed = true;
  }
  if (!current.current) {
    current = await apply(ports, 'refresh', request, current, { current: true });
    changed = true;
  }
  if (!current.persistent) {
    current = await apply(ports, 'persist', request, current, { persistent: true });
    changed = true;
  }
  if (!current.stored || !current.current || !current.persistent) {
    throw new Error('definition reconciliation did not reach exact readiness');
  }
  return Object.freeze({ protocol: PROTOCOL, ready: true, changed });
}

export {
  OBSERVATION_PROTOCOL as DEFINITION_OBSERVATION_PROTOCOL,
  PROTOCOL as DEFINITION_RECONCILIATION_PROTOCOL,
};
