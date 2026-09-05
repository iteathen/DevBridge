import { createHash } from 'node:crypto';

export const CONSTRUCTION_RETENTION_PROTOCOL = 'devbridge/construction-retention-v1';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PHASES = new Set(['planned', 'attempted', 'observed', 'reconciled', 'completed']);
const CLASSIFICATIONS = new Set(['current', 'accepted', 'recoverable', 'retained', 'ambiguous', 'obsolete']);
const MAX_SUBJECTS = 4096;
const MAX_REFERENCES = 4096;
const MAX_EFFECTS = 4096;
const MAX_ATTEMPTS = 2;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function subjectId(value, name = 'retention subject') {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}

function uniqueIds(raw, name, maximum) {
  if (!Array.isArray(raw) || raw.length > maximum) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => safeId(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicate identities`);
  return Object.freeze(values.sort());
}

function normalizeEffect(raw, index, seen) {
  const value = onlyKeys(raw, new Set(['identity', 'bytes', 'terminal']), `retention effect ${index}`);
  const identity = safeId(value.identity, `retention effect ${index}.identity`);
  if (seen.has(identity)) throw new TypeError('retention effects contain duplicate identities');
  seen.add(identity);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new TypeError(`retention effect ${index}.bytes is invalid`);
  return Object.freeze({
    identity,
    bytes: value.bytes,
    terminal: boolean(value.terminal, `retention effect ${index}.terminal`),
  });
}

function normalizeSubject(raw, index, effectIdentities) {
  const value = onlyKeys(
    raw,
    new Set(['identity', 'selected', 'recoverable', 'retained', 'ambiguous', 'references', 'effects']),
    `retention subject ${index}`,
  );
  const identity = subjectId(value.identity, `retention subject ${index}.identity`);
  const references = uniqueIds(value.references, `retention subject ${index}.references`, MAX_REFERENCES);
  if (!Array.isArray(value.effects) || value.effects.length === 0 || value.effects.length > MAX_EFFECTS) {
    throw new TypeError(`retention subject ${index}.effects is invalid`);
  }
  const effects = Object.freeze(value.effects.map((entry, effectIndex) => normalizeEffect(entry, effectIndex, effectIdentities)));
  if (effects.slice(0, -1).some((entry) => entry.terminal) || effects.at(-1).terminal !== true) {
    throw new TypeError(`retention subject ${index} must end with one terminal effect`);
  }
  return Object.freeze({
    identity,
    selected: boolean(value.selected, `retention subject ${index}.selected`),
    recoverable: boolean(value.recoverable, `retention subject ${index}.recoverable`),
    retained: boolean(value.retained, `retention subject ${index}.retained`),
    ambiguous: boolean(value.ambiguous, `retention subject ${index}.ambiguous`),
    references,
    effects,
  });
}

function normalizeSnapshot(raw) {
  const value = onlyKeys(raw, new Set(['generation', 'leaseActive', 'protectedReferences', 'subjects']), 'retention snapshot');
  const generation = safeId(value.generation, 'retention snapshot.generation');
  const protectedReferences = uniqueIds(value.protectedReferences, 'retention snapshot.protectedReferences', MAX_REFERENCES);
  if (!Array.isArray(value.subjects) || value.subjects.length === 0 || value.subjects.length > MAX_SUBJECTS) {
    throw new TypeError('retention snapshot.subjects is invalid');
  }
  const effectIdentities = new Set();
  const subjects = value.subjects.map((entry, index) => normalizeSubject(entry, index, effectIdentities));
  const identities = subjects.map((entry) => entry.identity);
  if (new Set(identities).size !== identities.length) throw new TypeError('retention snapshot contains duplicate subjects');
  if (subjects.filter((entry) => entry.selected).length !== 1) throw new TypeError('retention snapshot must identify exactly one current subject');
  return Object.freeze({
    generation,
    leaseActive: boolean(value.leaseActive, 'retention snapshot.leaseActive'),
    protectedReferences,
    subjects: Object.freeze(subjects.sort((left, right) => left.identity.localeCompare(right.identity))),
  });
}

function classification(subject, protectedReferences) {
  if (subject.selected) return 'current';
  if (subject.references.some((identity) => protectedReferences.has(identity))) return 'accepted';
  if (subject.recoverable) return 'recoverable';
  if (subject.retained) return 'retained';
  if (subject.ambiguous) return 'ambiguous';
  return 'obsolete';
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function createPlan(snapshot) {
  const protectedReferences = new Set(snapshot.protectedReferences);
  const subjects = snapshot.subjects.map((subject) => Object.freeze({
    ...subject,
    classification: classification(subject, protectedReferences),
  }));
  const authority = Object.freeze({
    protocol: CONSTRUCTION_RETENTION_PROTOCOL,
    generation: snapshot.generation,
    leaseActive: snapshot.leaseActive,
    protectedReferences: snapshot.protectedReferences,
    subjects: Object.freeze(subjects),
  });
  return Object.freeze({ authority, digest: sha256(authority) });
}

function publicPlan(plan) {
  return Object.freeze({
    protocol: CONSTRUCTION_RETENTION_PROTOCOL,
    generation: plan.authority.generation,
    digest: plan.digest,
    leaseActive: plan.authority.leaseActive,
    subjects: Object.freeze(plan.authority.subjects.map((subject) => Object.freeze({
      identity: subject.identity,
      classification: subject.classification,
      eligible: subject.classification === 'obsolete' && !plan.authority.leaseActive,
      effectCount: subject.effects.length,
      estimatedBytes: subject.effects.reduce((total, effect) => total + effect.bytes, 0),
    }))),
  });
}

function assertPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

function normalizeRecord(raw, identity) {
  if (raw == null) return null;
  const value = onlyKeys(
    raw,
    new Set(['protocol', 'identity', 'planDigest', 'generation', 'revision', 'cursor', 'phase', 'attempts', 'effects']),
    'retention journal record',
  );
  if (value.protocol !== CONSTRUCTION_RETENTION_PROTOCOL || value.identity !== identity) throw new Error('retention journal subject does not match');
  if (typeof value.planDigest !== 'string' || !SHA256.test(value.planDigest)) throw new Error('retention journal plan digest is invalid');
  const generation = safeId(value.generation, 'retention journal generation');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('retention journal revision is invalid');
  if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error('retention journal cursor is invalid');
  if (!PHASES.has(value.phase)) throw new Error('retention journal phase is invalid');
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > MAX_ATTEMPTS) throw new Error('retention journal attempt count is invalid');
  if (!Array.isArray(value.effects) || value.effects.length === 0 || value.effects.length > MAX_EFFECTS) throw new Error('retention journal effects are invalid');
  const seen = new Set();
  const effects = Object.freeze(value.effects.map((entry, index) => normalizeEffect(entry, index, seen)));
  if (effects.slice(0, -1).some((entry) => entry.terminal) || effects.at(-1).terminal !== true) throw new Error('retention journal terminal effect is invalid');
  if (value.phase === 'completed') {
    if (value.cursor !== effects.length || value.attempts !== 0) throw new Error('completed retention journal position is invalid');
  } else if (value.cursor >= effects.length) throw new Error('retention journal cursor exceeds its effects');
  return {
    protocol: CONSTRUCTION_RETENTION_PROTOCOL,
    identity,
    planDigest: value.planDigest,
    generation,
    revision: value.revision,
    cursor: value.cursor,
    phase: value.phase,
    attempts: value.attempts,
    effects,
  };
}

function publicStatus(record) {
  const completedEffects = record.phase === 'completed'
    ? record.effects.length
    : record.cursor + (record.phase === 'reconciled' ? 1 : 0);
  return Object.freeze({
    protocol: CONSTRUCTION_RETENTION_PROTOCOL,
    identity: record.identity,
    planDigest: record.planDigest,
    phase: record.phase,
    revision: record.revision,
    complete: record.phase === 'completed',
    completedEffects,
    effectCount: record.effects.length,
    estimatedBytes: record.effects.reduce((total, effect) => total + effect.bytes, 0),
    reconciledBytes: record.effects.slice(0, completedEffects).reduce((total, effect) => total + effect.bytes, 0),
  });
}

function normalizeObservation(raw, effect) {
  const value = onlyKeys(raw, new Set(['identity', 'state', 'retryable']), 'retention effect observation');
  if (value.identity !== effect.identity) throw new Error('retention effect observation identity changed');
  if (!['present', 'absent', 'ambiguous'].includes(value.state)) throw new Error('retention effect observation state is invalid');
  return Object.freeze({
    identity: effect.identity,
    state: value.state,
    retryable: boolean(value.retryable, 'retention effect observation.retryable'),
  });
}

function normalizeBinding(raw, identity, planDigest) {
  const value = onlyKeys(raw, new Set(['identity', 'planDigest', 'bound']), 'retention effect binding');
  if (value.identity !== identity || value.planDigest !== planDigest || value.bound !== true) {
    throw new Error('retention effect binding did not preserve plan authority');
  }
  return Object.freeze({ identity, planDigest, bound: true });
}

function progressObserver(value) {
  if (value == null) return null;
  if (typeof value !== 'function') throw new TypeError('retention progress observer is invalid');
  return value;
}

function publishProgress(observer, value) {
  if (!observer) return;
  try {
    const pending = observer(Object.freeze(value));
    pending?.catch?.(() => {});
  } catch {
    // Observation is deliberately unable to affect retention authority or effects.
  }
}

export class ConstructionRetention {
  #source;
  #journal;
  #effects;
  #onProgress;

  constructor({ source, journal, effects, onProgress = null } = {}) {
    this.#source = assertPort(source, ['snapshot'], 'retention source');
    this.#journal = assertPort(journal, ['load', 'save'], 'retention journal');
    this.#effects = assertPort(effects, ['bind', 'observe', 'remove'], 'retention effects');
    this.#onProgress = progressObserver(onProgress);
  }

  #emit(phase, record = null, total = null) {
    const effectTotal = record?.effects.length ?? total;
    const completed = record == null
      ? 0
      : record.cursor + (record.phase === 'reconciled' ? 1 : 0);
    publishProgress(this.#onProgress, {
      phase,
      completed,
      total: effectTotal,
      attempt: record?.attempts ?? 0,
    });
  }

  #emitRecord(record) {
    if (record.phase !== 'completed') this.#emit(record.phase, record);
  }

  async #plan(record = null) {
    this.#emit('planning', record);
    return createPlan(normalizeSnapshot(await this.#source.snapshot()));
  }

  async #save(record, changes) {
    const next = { ...record, ...changes, revision: record.revision + 1 };
    await this.#journal.save(record.identity, next);
    this.#emitRecord(next);
    return next;
  }

  async #requireStable(record) {
    const plan = await this.#plan(record);
    if (plan.digest !== record.planDigest || plan.authority.generation !== record.generation) throw new Error('retention plan changed before effect reconciliation');
    if (plan.authority.leaseActive) throw new Error('retention mutation lease is active');
    const subject = plan.authority.subjects.find((entry) => entry.identity === record.identity);
    if (!subject || subject.classification !== 'obsolete') throw new Error('retention subject is no longer obsolete');
    if (JSON.stringify(subject.effects) !== JSON.stringify(record.effects)) throw new Error('retention effect plan changed');
    this.#emitRecord(record);
    return subject;
  }

  async inspect() {
    return publicPlan(await this.#plan());
  }

  async retire(rawRequest) {
    const request = onlyKeys(rawRequest, new Set(['identity', 'planDigest']), 'retention request');
    const identity = subjectId(request.identity);
    if (typeof request.planDigest !== 'string' || !SHA256.test(request.planDigest)) throw new TypeError('retention request.planDigest is invalid');
    let record = normalizeRecord(await this.#journal.load(identity), identity);
    if (record?.phase === 'completed') {
      if (record.planDigest !== request.planDigest) throw new Error('completed retention receipt does not match the requested plan');
      return publicStatus(record);
    }

    const plan = await this.#plan();
    if (plan.digest !== request.planDigest) throw new Error('retention authorization does not match the current plan');
    if (plan.authority.leaseActive) throw new Error('retention mutation lease is active');
    const subject = plan.authority.subjects.find((entry) => entry.identity === identity);
    if (!subject) throw new Error('retention subject is unavailable');
    if (!CLASSIFICATIONS.has(subject.classification) || subject.classification !== 'obsolete') {
      throw new Error(`retention subject is protected as ${subject.classification}`);
    }
    this.#emit('binding', null, subject.effects.length);
    normalizeBinding(await this.#effects.bind(Object.freeze({
      identity,
      planDigest: plan.digest,
      effects: Object.freeze(subject.effects.map((effect) => Object.freeze({ ...effect }))),
    })), identity, plan.digest);

    if (!record) {
      record = {
        protocol: CONSTRUCTION_RETENTION_PROTOCOL,
        identity,
        planDigest: plan.digest,
        generation: plan.authority.generation,
        revision: 1,
        cursor: 0,
        phase: 'planned',
        attempts: 0,
        effects: subject.effects,
      };
      await this.#journal.save(identity, record);
      this.#emitRecord(record);
    } else {
      if (record.planDigest !== plan.digest || record.generation !== plan.authority.generation) throw new Error('retention journal does not match the current plan');
      await this.#requireStable(record);
    }

    while (record.phase !== 'completed') {
      const effect = record.effects[record.cursor];
      const input = Object.freeze({
        identity: record.identity,
        planDigest: record.planDigest,
        effect: Object.freeze({ ...effect }),
      });

      if (record.phase === 'planned') {
        await this.#requireStable(record);
        record = await this.#save(record, { phase: 'attempted', attempts: record.attempts + 1 });
        await this.#effects.remove(input);
      }

      if (record.phase === 'attempted') {
        let observed = normalizeObservation(await this.#effects.observe(input), effect);
        if (observed.state === 'ambiguous') throw new Error('retention effect is ambiguous after attempt');
        if (observed.state === 'present') {
          if (!observed.retryable || record.attempts >= MAX_ATTEMPTS) throw new Error('retention effect remains present after bounded reconciliation');
          await this.#requireStable(record);
          record = await this.#save(record, { attempts: record.attempts + 1 });
          await this.#effects.remove(input);
          observed = normalizeObservation(await this.#effects.observe(input), effect);
          if (observed.state !== 'absent') throw new Error('retention effect did not reconcile after bounded retry');
        }
        record = await this.#save(record, { phase: 'observed' });
      }

      if (record.phase === 'observed') {
        const observed = normalizeObservation(await this.#effects.observe(input), effect);
        if (observed.state !== 'absent') throw new Error('retention effect absence evidence changed');
        record = await this.#save(record, { phase: 'reconciled' });
      }

      if (record.phase === 'reconciled') {
        const nextCursor = record.cursor + 1;
        record = nextCursor === record.effects.length
          ? await this.#save(record, { cursor: nextCursor, phase: 'completed', attempts: 0 })
          : await this.#save(record, { cursor: nextCursor, phase: 'planned', attempts: 0 });
      }
    }
    return publicStatus(record);
  }
}

export function createConstructionRetention(options) {
  return new ConstructionRetention(options);
}
