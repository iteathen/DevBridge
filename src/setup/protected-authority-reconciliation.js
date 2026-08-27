import { createHash } from 'node:crypto';

const PROTOCOL = 'devbridge/protected-authority-reconciliation-v1';
const JOURNAL_PROTOCOL = 'devbridge/protected-authority-reconciliation-journal-v1';
const OBSERVATION_PROTOCOL = 'devbridge/protected-authority-observation-v1';
const GENERATION = /^[0-9a-f]{64}$/u;
const EFFECTS = new Set(['stage', 'quiesce', 'promote', 'start', 'restore']);
const PHASES = new Set(['observed', 'staged', 'verified', 'quiesced', 'promoted', 'started', 'restored', 'complete', 'rejected', 'blocked']);
const OUTCOMES = new Set(['in-progress', 'complete', 'rejected', 'blocked']);
const REASONS = new Set([null, 'candidate-verification', 'candidate-health', 'recovery-health', 'ambiguous-effect']);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function generation(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !GENERATION.test(value)) throw new TypeError(`${name} must be an exact content generation`);
  return value;
}

function normalizeCandidate(value) {
  exactKeys(value, new Set(['generation']), 'protected authority candidate');
  return Object.freeze({ generation: generation(value.generation, 'protected authority candidate generation') });
}

function normalizeObservation(value) {
  exactKeys(value, new Set(['protocol', 'ownership', 'activeGeneration', 'stagedGeneration', 'running', 'retainedGenerations']), 'protected authority observation');
  if (value.protocol !== OBSERVATION_PROTOCOL) throw new TypeError('protected authority observation protocol is invalid');
  if (!['absent', 'owned', 'foreign', 'ambiguous'].includes(value.ownership)) throw new TypeError('protected authority observation ownership is invalid');
  const activeGeneration = generation(value.activeGeneration, 'protected authority active generation', { nullable: true });
  const stagedGeneration = generation(value.stagedGeneration, 'protected authority staged generation', { nullable: true });
  if (typeof value.running !== 'boolean') throw new TypeError('protected authority running observation is invalid');
  if (!Array.isArray(value.retainedGenerations) || value.retainedGenerations.length > 8) throw new TypeError('protected authority retained generation evidence is invalid');
  const retainedGenerations = value.retainedGenerations.map((entry) => generation(entry, 'protected authority retained generation'));
  if (new Set(retainedGenerations).size !== retainedGenerations.length) throw new TypeError('protected authority retained generation evidence is ambiguous');
  if (value.running && activeGeneration == null) throw new TypeError('protected authority cannot run without an active generation');
  if (activeGeneration != null && stagedGeneration === activeGeneration) throw new TypeError('protected authority active and staged generations cannot alias');
  if (activeGeneration != null && retainedGenerations.includes(activeGeneration)) throw new TypeError('protected authority active generation cannot also be retained');
  if (stagedGeneration != null && retainedGenerations.includes(stagedGeneration)) throw new TypeError('protected authority staged generation cannot also be retained');
  if (value.ownership === 'absent' && (activeGeneration != null || stagedGeneration != null || value.running || retainedGenerations.length > 0)) {
    throw new TypeError('absent protected authority observation contains installation state');
  }
  return Object.freeze({
    protocol: OBSERVATION_PROTOCOL,
    ownership: value.ownership,
    activeGeneration,
    stagedGeneration,
    running: value.running,
    retainedGenerations: Object.freeze(retainedGenerations),
  });
}

function normalizePending(value) {
  if (value == null) return null;
  exactKeys(value, new Set(['effect', 'targetGeneration', 'status', 'attempt']), 'protected authority pending effect');
  if (!EFFECTS.has(value.effect)) throw new TypeError('protected authority pending effect is invalid');
  if (!['planned', 'attempted'].includes(value.status)) throw new TypeError('protected authority pending effect state is invalid');
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 64) throw new TypeError('protected authority pending effect attempt is invalid');
  return Object.freeze({
    effect: value.effect,
    targetGeneration: generation(value.targetGeneration, 'protected authority pending target generation'),
    status: value.status,
    attempt: value.attempt,
  });
}

function normalizeJournal(value) {
  if (value == null) return null;
  exactKeys(value, new Set(['protocol', 'transactionId', 'candidateGeneration', 'previousGeneration', 'phase', 'pending', 'outcome', 'reason']), 'protected authority reconciliation journal');
  if (value.protocol !== JOURNAL_PROTOCOL) throw new TypeError('protected authority reconciliation journal protocol is invalid');
  if (typeof value.transactionId !== 'string' || !GENERATION.test(value.transactionId)) throw new TypeError('protected authority reconciliation transaction identity is invalid');
  if (!PHASES.has(value.phase)) throw new TypeError('protected authority reconciliation phase is invalid');
  if (!OUTCOMES.has(value.outcome)) throw new TypeError('protected authority reconciliation outcome is invalid');
  if (!REASONS.has(value.reason ?? null)) throw new TypeError('protected authority reconciliation reason is invalid');
  const normalized = Object.freeze({
    protocol: JOURNAL_PROTOCOL,
    transactionId: value.transactionId,
    candidateGeneration: generation(value.candidateGeneration, 'protected authority journal candidate generation'),
    previousGeneration: generation(value.previousGeneration, 'protected authority journal previous generation', { nullable: true }),
    phase: value.phase,
    pending: normalizePending(value.pending),
    outcome: value.outcome,
    reason: value.reason ?? null,
  });
  if (normalized.outcome === 'in-progress' && ['complete', 'rejected', 'blocked'].includes(normalized.phase)) throw new TypeError('protected authority reconciliation journal outcome disagrees with phase');
  if (normalized.outcome !== 'in-progress' && normalized.pending != null) throw new TypeError('terminal protected authority reconciliation journal cannot retain a pending effect');
  return normalized;
}

function transactionId(previousGeneration, candidateGeneration) {
  return createHash('sha256')
    .update('devbridge/protected-authority-reconciliation-v1\0', 'utf8')
    .update(previousGeneration ?? 'absent', 'utf8')
    .update('\0', 'utf8')
    .update(candidateGeneration, 'utf8')
    .digest('hex');
}

function initialJournal(candidateGeneration, previousGeneration) {
  return Object.freeze({
    protocol: JOURNAL_PROTOCOL,
    transactionId: transactionId(previousGeneration, candidateGeneration),
    candidateGeneration,
    previousGeneration,
    phase: 'observed',
    pending: null,
    outcome: 'in-progress',
    reason: null,
  });
}

function withJournal(record, changes) {
  return normalizeJournal({ ...record, ...changes });
}

function requirePorts(ports) {
  exactKeys(ports, new Set(['journal', 'observe', 'stage', 'verify', 'quiesce', 'promote', 'start', 'health', 'restore']), 'protected authority reconciliation ports');
  exactKeys(ports.journal, new Set(['load', 'save']), 'protected authority reconciliation journal port');
  for (const [name, value] of Object.entries({
    load: ports.journal.load,
    save: ports.journal.save,
    observe: ports.observe,
    stage: ports.stage,
    verify: ports.verify,
    quiesce: ports.quiesce,
    promote: ports.promote,
    start: ports.start,
    health: ports.health,
    restore: ports.restore,
  })) if (typeof value !== 'function') throw new TypeError(`protected authority reconciliation ${name} port is invalid`);
  return ports;
}

async function save(journal, record) {
  const normalized = normalizeJournal(record);
  await journal.save(normalized);
  return normalized;
}

async function observe(ports) {
  return normalizeObservation(await ports.observe());
}

function owned(observation) {
  if (observation.ownership === 'foreign' || observation.ownership === 'ambiguous') {
    throw new Error('protected authority ownership is not exact; reconciliation is blocked');
  }
}

function exactCurrent(observation, candidateGeneration) {
  return observation.ownership === 'owned'
    && observation.activeGeneration === candidateGeneration
    && observation.running === true;
}

async function health(ports, targetGeneration) {
  const value = await ports.health(Object.freeze({ generation: targetGeneration }));
  exactKeys(value, new Set(['generation', 'ready']), 'protected authority health evidence');
  if (generation(value.generation, 'protected authority health generation') !== targetGeneration || typeof value.ready !== 'boolean') {
    throw new Error('protected authority health evidence does not match the exact generation');
  }
  return value.ready;
}

async function verify(ports, targetGeneration) {
  const value = await ports.verify(Object.freeze({ generation: targetGeneration }));
  exactKeys(value, new Set(['generation', 'verified']), 'protected authority verification evidence');
  if (generation(value.generation, 'protected authority verification generation') !== targetGeneration || typeof value.verified !== 'boolean') {
    throw new Error('protected authority verification evidence does not match the exact generation');
  }
  return value.verified;
}

function effectPhase(effect) {
  return Object.freeze({ stage: 'staged', quiesce: 'quiesced', promote: 'promoted', start: 'started', restore: 'restored' })[effect];
}

function effectStatus(pending, observation, record) {
  const candidate = record.candidateGeneration;
  const previous = record.previousGeneration;
  switch (pending.effect) {
    case 'stage':
      if (observation.stagedGeneration === pending.targetGeneration || observation.activeGeneration === pending.targetGeneration) return 'complete';
      if (observation.stagedGeneration == null && observation.activeGeneration === previous) return 'not-occurred';
      if (previous == null && observation.stagedGeneration == null && observation.activeGeneration == null) return 'not-occurred';
      return 'ambiguous';
    case 'quiesce':
      if (observation.activeGeneration === pending.targetGeneration && observation.running === false) return 'complete';
      if (observation.activeGeneration === candidate) return 'complete';
      if (observation.activeGeneration === pending.targetGeneration && observation.running === true) return 'not-occurred';
      return 'ambiguous';
    case 'promote':
      if (observation.activeGeneration === pending.targetGeneration) return 'complete';
      if (observation.activeGeneration === previous && observation.stagedGeneration === pending.targetGeneration && observation.running === false) return 'not-occurred';
      if (previous == null && observation.activeGeneration == null && observation.stagedGeneration === pending.targetGeneration) return 'not-occurred';
      return 'ambiguous';
    case 'start':
      if (observation.activeGeneration === pending.targetGeneration && observation.running === true) return 'complete';
      if (observation.activeGeneration === pending.targetGeneration && observation.running === false) return 'not-occurred';
      return 'ambiguous';
    case 'restore':
      if (observation.activeGeneration === pending.targetGeneration) return 'complete';
      if (observation.activeGeneration === candidate) return 'not-occurred';
      return 'ambiguous';
    default:
      return 'ambiguous';
  }
}

function effectArguments(effect, targetGeneration, record) {
  if (effect === 'promote') return Object.freeze({ generation: targetGeneration, previousGeneration: record.previousGeneration });
  if (effect === 'restore') return Object.freeze({ generation: targetGeneration, failedGeneration: record.candidateGeneration });
  return Object.freeze({ generation: targetGeneration });
}

async function invokeEffect(ports, record, effect, targetGeneration, attempt = 1) {
  record = await save(ports.journal, withJournal(record, {
    pending: Object.freeze({ effect, targetGeneration, status: 'planned', attempt }),
  }));
  record = await save(ports.journal, withJournal(record, {
    pending: Object.freeze({ effect, targetGeneration, status: 'attempted', attempt }),
  }));
  await ports[effect](effectArguments(effect, targetGeneration, record));
  return record;
}

async function checkpointPending(ports, record, observation) {
  const pending = record.pending;
  if (pending == null) return Object.freeze({ record, observation, changed: false });
  const status = effectStatus(pending, observation, record);
  if (status === 'ambiguous') {
    const blocked = await save(ports.journal, withJournal(record, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'ambiguous-effect' }));
    throw new Error(`protected authority ${pending.effect} effect is ambiguous at transaction ${blocked.transactionId}`);
  }
  if (status === 'complete') {
    const advanced = await save(ports.journal, withJournal(record, { phase: effectPhase(pending.effect), pending: null }));
    return Object.freeze({ record: advanced, observation, changed: false });
  }

  const attempted = await invokeEffect(ports, record, pending.effect, pending.targetGeneration, pending.attempt + 1);
  const nextObservation = await observe(ports);
  owned(nextObservation);
  const after = effectStatus(attempted.pending, nextObservation, attempted);
  if (after !== 'complete') {
    if (after === 'ambiguous') {
      await save(ports.journal, withJournal(attempted, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'ambiguous-effect' }));
      throw new Error(`protected authority ${pending.effect} effect became ambiguous after exact replay`);
    }
    throw new Error(`protected authority ${pending.effect} effect did not become observable after exact replay`);
  }
  const advanced = await save(ports.journal, withJournal(attempted, { phase: effectPhase(pending.effect), pending: null }));
  return Object.freeze({ record: advanced, observation: nextObservation, changed: true });
}

function assertCompatibleObservation(observation, record) {
  owned(observation);
  const allowed = new Set([record.candidateGeneration]);
  if (record.previousGeneration != null) allowed.add(record.previousGeneration);
  for (const value of [observation.activeGeneration, observation.stagedGeneration]) {
    if (value != null && !allowed.has(value)) throw new Error('protected authority observation contains an unexpected generation');
  }
}

function canReplacePreEffectTransaction(observation, record) {
  return record.phase === 'observed'
    && record.pending == null
    && observation.activeGeneration === record.previousGeneration
    && observation.stagedGeneration == null;
}

function previousRetained(observation, record) {
  return record.previousGeneration == null || record.previousGeneration === record.candidateGeneration || observation.retainedGenerations.includes(record.previousGeneration);
}

async function rejectCandidate(ports, record, reason, { changed, recover = true } = {}) {
  let observation = await observe(ports);
  assertCompatibleObservation(observation, record);
  if (record.previousGeneration == null || record.previousGeneration === record.candidateGeneration || !recover) {
    if (observation.activeGeneration === record.candidateGeneration && observation.running) {
      record = await invokeEffect(ports, record, 'quiesce', record.candidateGeneration);
      observation = await observe(ports);
      assertCompatibleObservation(observation, record);
      const status = effectStatus(record.pending, observation, record);
      if (status !== 'complete') throw new Error('protected authority failed candidate could not be quiesced exactly');
      record = await save(ports.journal, withJournal(record, { phase: 'quiesced', pending: null }));
      changed = true;
    }
    record = await save(ports.journal, withJournal(record, { phase: 'rejected', pending: null, outcome: 'rejected', reason }));
    return Object.freeze({ protocol: PROTOCOL, ready: false, changed, generation: observation.activeGeneration, recovered: false, blocker: reason });
  }

  if (!observation.retainedGenerations.includes(record.previousGeneration)) {
    const blocked = await save(ports.journal, withJournal(record, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'ambiguous-effect' }));
    throw new Error(`protected authority previous generation is not retained for transaction ${blocked.transactionId}`);
  }
  record = await invokeEffect(ports, record, 'restore', record.previousGeneration);
  observation = await observe(ports);
  assertCompatibleObservation(observation, record);
  if (effectStatus(record.pending, observation, record) !== 'complete') throw new Error('protected authority previous generation restoration is not observable');
  record = await save(ports.journal, withJournal(record, { phase: 'restored', pending: null }));
  changed = true;

  if (!observation.running) {
    record = await invokeEffect(ports, record, 'start', record.previousGeneration);
    observation = await observe(ports);
    assertCompatibleObservation(observation, record);
    if (effectStatus(record.pending, observation, record) !== 'complete') throw new Error('protected authority restored generation did not start observably');
    record = await save(ports.journal, withJournal(record, { phase: 'started', pending: null }));
  }
  if (!await health(ports, record.previousGeneration)) {
    const blocked = await save(ports.journal, withJournal(record, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'recovery-health' }));
    throw new Error(`protected authority previous generation failed recovery health at transaction ${blocked.transactionId}`);
  }
  await save(ports.journal, withJournal(record, { phase: 'rejected', pending: null, outcome: 'rejected', reason }));
  return Object.freeze({ protocol: PROTOCOL, ready: false, changed, generation: record.previousGeneration, recovered: true, blocker: reason });
}

export async function reconcileProtectedAuthority({ candidate, ports } = {}) {
  const selected = normalizeCandidate(candidate);
  const local = requirePorts(ports);
  let record = normalizeJournal(await local.journal.load());
  let observation = await observe(local);
  owned(observation);

  if (record?.outcome === 'blocked') {
    if (record.reason === 'recovery-health'
        && record.previousGeneration != null
        && observation.activeGeneration === record.previousGeneration
        && observation.running === true) {
      assertCompatibleObservation(observation, record);
      if (await health(local, record.previousGeneration)) {
        record = await save(local.journal, withJournal(record, { phase: 'rejected', pending: null, outcome: 'rejected', reason: 'candidate-health' }));
        return Object.freeze({
          protocol: PROTOCOL,
          ready: false,
          changed: false,
          generation: record.previousGeneration,
          recovered: true,
          blocker: 'candidate-health',
          transactionId: record.transactionId,
        });
      }
    }
    throw new Error(`protected authority reconciliation is blocked at transaction ${record.transactionId}`);
  }

  if (record?.outcome === 'in-progress' && record.candidateGeneration !== selected.generation) {
    if (!canReplacePreEffectTransaction(observation, record)) {
      throw new Error('protected authority candidate changed while reconciliation is active');
    }
    record = await save(local.journal, initialJournal(selected.generation, observation.activeGeneration));
  }

  if (exactCurrent(observation, selected.generation) && await health(local, selected.generation)) {
    if (record?.outcome === 'in-progress' && record.candidateGeneration === selected.generation) {
      assertCompatibleObservation(observation, record);
      if (!previousRetained(observation, record)) {
        await save(local.journal, withJournal(record, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'ambiguous-effect' }));
        throw new Error('protected authority promotion did not retain the exact previous generation');
      }
      record = await save(local.journal, withJournal(record, { phase: 'complete', pending: null, outcome: 'complete', reason: null }));
      return Object.freeze({ protocol: PROTOCOL, ready: true, changed: false, generation: selected.generation, recovered: false, blocker: null, transactionId: record.transactionId });
    }
    return Object.freeze({ protocol: PROTOCOL, ready: true, changed: false, generation: selected.generation, recovered: false, blocker: null, transactionId: null });
  }

  if (record?.outcome === 'rejected' && record.candidateGeneration === selected.generation) {
    if (record.previousGeneration != null && observation.activeGeneration === record.previousGeneration && observation.running && await health(local, record.previousGeneration)) {
      return Object.freeze({ protocol: PROTOCOL, ready: false, changed: false, generation: record.previousGeneration, recovered: true, blocker: record.reason, transactionId: record.transactionId });
    }
    throw new Error('protected authority rejected candidate no longer has its verified recovery state');
  }
  if (record == null || record.outcome !== 'in-progress') {
    if (observation.ownership === 'owned' && observation.activeGeneration === selected.generation) {
      throw new Error('protected authority exact current generation is unhealthy and requires an activation repair contract');
    }
    record = await save(local.journal, initialJournal(selected.generation, observation.activeGeneration));
  }

  let changed = false;

  if (record.pending != null) {
    const reconciled = await checkpointPending(local, record, observation);
    record = reconciled.record;
    observation = reconciled.observation;
    changed ||= reconciled.changed;
  }

  for (let guard = 0; guard < 16; guard += 1) {
    assertCompatibleObservation(observation, record);

    if (observation.activeGeneration === selected.generation) {
      if (!previousRetained(observation, record)) {
        await save(local.journal, withJournal(record, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'ambiguous-effect' }));
        throw new Error('protected authority promotion did not retain the exact previous generation');
      }
      if (!observation.running) {
        record = await invokeEffect(local, record, 'start', selected.generation);
        changed = true;
        observation = await observe(local);
        assertCompatibleObservation(observation, record);
        if (effectStatus(record.pending, observation, record) !== 'complete') throw new Error('protected authority candidate start is not observable');
        record = await save(local.journal, withJournal(record, { phase: 'started', pending: null }));
        continue;
      }
      if (await health(local, selected.generation)) {
        record = await save(local.journal, withJournal(record, { phase: 'complete', pending: null, outcome: 'complete', reason: null }));
        return Object.freeze({ protocol: PROTOCOL, ready: true, changed, generation: selected.generation, recovered: false, blocker: null, transactionId: record.transactionId });
      }
      return rejectCandidate(local, record, 'candidate-health', { changed });
    }

    if (observation.stagedGeneration === selected.generation) {
      if (!await verify(local, selected.generation)) return rejectCandidate(local, record, 'candidate-verification', { changed, recover: false });
      if (record.phase !== 'verified') record = await save(local.journal, withJournal(record, { phase: 'verified' }));

      if (record.previousGeneration != null && observation.activeGeneration === record.previousGeneration && observation.running) {
        record = await invokeEffect(local, record, 'quiesce', record.previousGeneration);
        changed = true;
        observation = await observe(local);
        assertCompatibleObservation(observation, record);
        if (effectStatus(record.pending, observation, record) !== 'complete') throw new Error('protected authority previous generation quiesce is not observable');
        record = await save(local.journal, withJournal(record, { phase: 'quiesced', pending: null }));
        continue;
      }

      record = await invokeEffect(local, record, 'promote', selected.generation);
      changed = true;
      observation = await observe(local);
      assertCompatibleObservation(observation, record);
      if (effectStatus(record.pending, observation, record) !== 'complete') throw new Error('protected authority candidate promotion is not observable');
      record = await save(local.journal, withJournal(record, { phase: 'promoted', pending: null }));
      continue;
    }

    if (observation.activeGeneration === record.previousGeneration || (record.previousGeneration == null && observation.activeGeneration == null)) {
      record = await invokeEffect(local, record, 'stage', selected.generation);
      changed = true;
      observation = await observe(local);
      assertCompatibleObservation(observation, record);
      if (effectStatus(record.pending, observation, record) !== 'complete') throw new Error('protected authority candidate staging is not observable');
      record = await save(local.journal, withJournal(record, { phase: 'staged', pending: null }));
      continue;
    }

    await save(local.journal, withJournal(record, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'ambiguous-effect' }));
    throw new Error('protected authority reconciliation observation is ambiguous');
  }

  await save(local.journal, withJournal(record, { phase: 'blocked', pending: null, outcome: 'blocked', reason: 'ambiguous-effect' }));
  throw new Error('protected authority reconciliation exceeded its bounded transition count');
}

export {
  JOURNAL_PROTOCOL as PROTECTED_AUTHORITY_RECONCILIATION_JOURNAL_PROTOCOL,
  OBSERVATION_PROTOCOL as PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
  PROTOCOL as PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL,
  normalizeJournal as normalizeProtectedAuthorityReconciliationJournal,
};
