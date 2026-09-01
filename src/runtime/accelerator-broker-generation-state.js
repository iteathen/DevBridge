export const ACCELERATOR_BROKER_GENERATION_STATE_PROTOCOL = 'devbridge/accelerator-broker-generation-state-v1';

export const ACCELERATOR_BROKER_GENERATION_PHASE = Object.freeze({
  ACTIVE: 'active',
  RETIRING: 'retiring',
});

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

function revision(value, name = 'accelerator broker generation state.revision') {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeSession(raw, name = 'accelerator broker generation state.session') {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['identity', 'generation']), name);
  return Object.freeze({
    identity: safeId(value.identity, `${name}.identity`),
    generation: safeId(value.generation, `${name}.generation`),
  });
}

function normalizeRetirement(raw, name = 'accelerator broker generation state.retirement') {
  if (raw == null) return null;
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['operationId', 'nextGeneration']), name);
  return Object.freeze({
    operationId: safeId(value.operationId, `${name}.operationId`),
    nextGeneration: safeId(value.nextGeneration, `${name}.nextGeneration`),
  });
}

function normalizePromotion(raw, name = 'accelerator broker generation state.lastPromotion') {
  if (raw == null) return null;
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['operationId', 'fromGeneration', 'toGeneration']), name);
  const fromGeneration = safeId(value.fromGeneration, `${name}.fromGeneration`);
  const toGeneration = safeId(value.toGeneration, `${name}.toGeneration`);
  if (fromGeneration === toGeneration) throw new TypeError(`${name} generations must differ`);
  return Object.freeze({
    operationId: safeId(value.operationId, `${name}.operationId`),
    fromGeneration,
    toGeneration,
  });
}

export function normalizeAcceleratorBrokerGenerationStateKey(raw) {
  const value = requireObject(raw, 'accelerator broker generation state key');
  onlyKeys(value, new Set(['sessionIdentity']), 'accelerator broker generation state key');
  return Object.freeze({
    sessionIdentity: safeId(value.sessionIdentity, 'accelerator broker generation state key.sessionIdentity'),
  });
}

export function acceleratorBrokerGenerationStateKey(rawRecord) {
  const record = normalizeAcceleratorBrokerGenerationStateRecord(rawRecord);
  return Object.freeze({ sessionIdentity: record.session.identity });
}

export function normalizeAcceleratorBrokerGenerationStateRecord(raw) {
  const value = requireObject(raw, 'accelerator broker generation state');
  onlyKeys(value, new Set([
    'protocol', 'revision', 'session', 'phase', 'retirement', 'lastPromotion',
  ]), 'accelerator broker generation state');
  if (value.protocol !== ACCELERATOR_BROKER_GENERATION_STATE_PROTOCOL) {
    throw new TypeError('accelerator broker generation state protocol is unsupported');
  }
  const session = normalizeSession(value.session);
  const phase = safeId(value.phase, 'accelerator broker generation state.phase');
  if (!Object.values(ACCELERATOR_BROKER_GENERATION_PHASE).includes(phase)) {
    throw new TypeError('accelerator broker generation state.phase is unsupported');
  }
  const retirement = normalizeRetirement(value.retirement);
  const lastPromotion = normalizePromotion(value.lastPromotion);
  if (phase === ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE && retirement != null) {
    throw new TypeError('active accelerator broker generation state cannot carry retirement intent');
  }
  if (phase === ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING) {
    if (retirement == null) throw new TypeError('retiring accelerator broker generation state requires retirement intent');
    if (retirement.nextGeneration === session.generation) {
      throw new TypeError('retiring accelerator broker generation state next generation must differ');
    }
  }
  if (lastPromotion && lastPromotion.toGeneration !== session.generation) {
    throw new TypeError('accelerator broker generation state last promotion does not lead to current generation');
  }
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_GENERATION_STATE_PROTOCOL,
    revision: revision(value.revision),
    session,
    phase,
    retirement,
    lastPromotion,
  });
}

export function createAcceleratorBrokerGenerationStateRecord({ sessionIdentity, generation } = {}) {
  return normalizeAcceleratorBrokerGenerationStateRecord({
    protocol: ACCELERATOR_BROKER_GENERATION_STATE_PROTOCOL,
    revision: 1,
    session: {
      identity: safeId(sessionIdentity, 'accelerator broker generation state initial sessionIdentity'),
      generation: safeId(generation, 'accelerator broker generation state initial generation'),
    },
    phase: ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE,
    retirement: null,
    lastPromotion: null,
  });
}

export function beginAcceleratorBrokerGenerationRetirement(rawRecord, { operationId, nextGeneration } = {}) {
  const record = normalizeAcceleratorBrokerGenerationStateRecord(rawRecord);
  if (record.phase !== ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE) {
    throw new TypeError('accelerator broker generation retirement requires active state');
  }
  const selectedOperationId = safeId(operationId, 'accelerator broker generation retirement operationId');
  const selectedNextGeneration = safeId(nextGeneration, 'accelerator broker generation retirement nextGeneration');
  if (selectedNextGeneration === record.session.generation) {
    throw new TypeError('accelerator broker generation retirement next generation must differ');
  }
  return normalizeAcceleratorBrokerGenerationStateRecord({
    protocol: ACCELERATOR_BROKER_GENERATION_STATE_PROTOCOL,
    revision: record.revision + 1,
    session: record.session,
    phase: ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING,
    retirement: { operationId: selectedOperationId, nextGeneration: selectedNextGeneration },
    lastPromotion: record.lastPromotion,
  });
}

export function promoteAcceleratorBrokerGeneration(rawRecord, { operationId } = {}) {
  const record = normalizeAcceleratorBrokerGenerationStateRecord(rawRecord);
  if (record.phase !== ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING || !record.retirement) {
    throw new TypeError('accelerator broker generation promotion requires retiring state');
  }
  const selectedOperationId = safeId(operationId, 'accelerator broker generation promotion operationId');
  if (selectedOperationId !== record.retirement.operationId) {
    throw new TypeError('accelerator broker generation promotion operation does not match retirement intent');
  }
  const fromGeneration = record.session.generation;
  const toGeneration = record.retirement.nextGeneration;
  return normalizeAcceleratorBrokerGenerationStateRecord({
    protocol: ACCELERATOR_BROKER_GENERATION_STATE_PROTOCOL,
    revision: record.revision + 1,
    session: { identity: record.session.identity, generation: toGeneration },
    phase: ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE,
    retirement: null,
    lastPromotion: { operationId: selectedOperationId, fromGeneration, toGeneration },
  });
}

function samePromotion(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return left.operationId === right.operationId
    && left.fromGeneration === right.fromGeneration
    && left.toGeneration === right.toGeneration;
}

export function assertAcceleratorBrokerGenerationStateTransition(rawPrevious, rawNext) {
  const previous = normalizeAcceleratorBrokerGenerationStateRecord(rawPrevious);
  const next = normalizeAcceleratorBrokerGenerationStateRecord(rawNext);
  if (next.revision !== previous.revision + 1) {
    throw new TypeError('accelerator broker generation state transition revision is not contiguous');
  }
  if (next.session.identity !== previous.session.identity) {
    throw new TypeError('accelerator broker generation state transition changed session identity');
  }
  if (previous.phase === ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE) {
    if (next.phase !== ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING
      || next.session.generation !== previous.session.generation
      || !next.retirement
      || next.retirement.nextGeneration === previous.session.generation
      || !samePromotion(next.lastPromotion, previous.lastPromotion)) {
      throw new TypeError('accelerator broker generation state active transition is invalid');
    }
    return next;
  }
  if (previous.phase === ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING) {
    if (next.phase !== ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE
      || next.retirement != null
      || next.session.generation !== previous.retirement?.nextGeneration
      || !next.lastPromotion
      || next.lastPromotion.operationId !== previous.retirement?.operationId
      || next.lastPromotion.fromGeneration !== previous.session.generation
      || next.lastPromotion.toGeneration !== previous.retirement?.nextGeneration) {
      throw new TypeError('accelerator broker generation state promotion transition is invalid');
    }
    return next;
  }
  throw new TypeError('accelerator broker generation state transition is unsupported');
}
