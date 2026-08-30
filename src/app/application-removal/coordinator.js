import {
  APPLICATION_REMOVAL_PROTOCOL,
  maximumRemovalAttempts,
  normalizeInspectionRequest,
  normalizeRemovalBinding,
  normalizeRemovalObservation,
  normalizeRemovalRecord,
  normalizeRemovalRequest,
} from './contract.js';
import { createRemovalPlan, publicRemovalPlan } from './planner.js';

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

function effectInput(record, effect) {
  return Object.freeze({
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    mode: record.mode,
    item: effect.item,
    planDigest: record.planDigest,
    effect: Object.freeze({ identity: effect.identity, bytes: effect.bytes, terminal: effect.terminal }),
  });
}

function publicStatus(record) {
  const groups = new Map();
  record.effects.forEach((effect, index) => {
    if (!groups.has(effect.item)) groups.set(effect.item, []);
    groups.get(effect.item).push(record.outcomes[index]);
  });
  const removed = [];
  const absent = [];
  for (const [identity, outcomes] of groups) {
    if (outcomes.some((value) => value == null)) continue;
    (outcomes.includes('removed') ? removed : absent).push(identity);
  }
  removed.sort((left, right) => left.localeCompare(right));
  absent.sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    mode: record.mode,
    planDigest: record.planDigest,
    phase: record.phase,
    revision: record.revision,
    complete: record.phase === 'completed',
    completedEffects: record.phase === 'completed'
      ? record.effects.length
      : record.cursor + (['observed', 'reconciled'].includes(record.phase) ? 1 : 0),
    effectCount: record.effects.length,
    removed: Object.freeze(removed),
    absent: Object.freeze(absent),
    preserved: record.preserved,
  });
}

export class ApplicationRemoval {
  #source;
  #journal;
  #effects;

  constructor({ source, journal, effects } = {}) {
    this.#source = requirePort(source, ['snapshot'], 'removal source');
    this.#journal = requirePort(journal, ['load', 'save'], 'removal journal');
    this.#effects = requirePort(effects, ['bind', 'observe', 'remove'], 'removal effects');
  }

  async #plan(mode) {
    return createRemovalPlan(await this.#source.snapshot(), mode);
  }

  async #save(record, changes) {
    const next = normalizeRemovalRecord({ ...record, ...changes, revision: record.revision + 1 });
    await this.#journal.save(record.mode, next);
    return next;
  }

  async #requireStable(record) {
    const plan = await this.#plan(record.mode);
    if (plan.digest !== record.planDigest || plan.authority.generation !== record.generation) {
      throw new Error('removal plan changed before effect reconciliation');
    }
    if (!plan.complete) throw new Error('removal mode coverage is incomplete');
    if (!plan.ready) throw new Error('removal mutation is not ready');
    if (JSON.stringify(plan.effects) !== JSON.stringify(record.effects)
        || JSON.stringify(plan.preserved.map(({ identity, reasons }) => ({ identity, reasons }))) !== JSON.stringify(record.preserved)) {
      throw new Error('removal effect plan changed before reconciliation');
    }
    return plan;
  }

  async #bind(record, effect) {
    const input = effectInput(record, effect);
    normalizeRemovalBinding(await this.#effects.bind(input), input);
    return input;
  }

  async inspect(rawRequest) {
    const request = normalizeInspectionRequest(rawRequest);
    return publicRemovalPlan(await this.#plan(request.mode));
  }

  async remove(rawRequest) {
    const request = normalizeRemovalRequest(rawRequest);
    let record = normalizeRemovalRecord(await this.#journal.load(request.mode));
    if (record?.phase === 'completed') {
      if (record.planDigest !== request.planDigest) throw new Error('completed removal receipt does not match the requested plan');
      return publicStatus(record);
    }

    const plan = await this.#plan(request.mode);
    if (plan.digest !== request.planDigest) throw new Error('removal authorization does not match the current plan');
    if (!plan.complete) throw new Error('removal mode coverage is incomplete');
    if (!plan.ready) throw new Error('removal mutation is not ready');

    if (!record) {
      record = normalizeRemovalRecord({
        protocol: APPLICATION_REMOVAL_PROTOCOL,
        mode: request.mode,
        planDigest: plan.digest,
        generation: plan.authority.generation,
        revision: 1,
        cursor: 0,
        phase: plan.effects.length === 0 ? 'completed' : 'planned',
        attempts: 0,
        effects: plan.effects,
        preserved: plan.preserved.map(({ identity, reasons }) => ({ identity, reasons })),
        outcomes: plan.effects.map(() => null),
      });
      await this.#journal.save(request.mode, record);
      if (record.phase === 'completed') return publicStatus(record);
    } else {
      if (record.mode !== request.mode || record.planDigest !== plan.digest || record.generation !== plan.authority.generation) {
        throw new Error('removal journal does not match the current plan');
      }
      await this.#requireStable(record);
    }

    while (record.phase !== 'completed') {
      await this.#requireStable(record);
      const effect = record.effects[record.cursor];

      if (record.phase === 'planned') {
        let input = await this.#bind(record, effect);
        const observed = normalizeRemovalObservation(await this.#effects.observe(input), effect);
        if (observed.state === 'ambiguous') throw new Error('removal effect is ambiguous before attempt');
        if (observed.state === 'absent') {
          const outcomes = [...record.outcomes];
          outcomes[record.cursor] = 'absent';
          record = await this.#save(record, { phase: 'observed', outcomes });
        } else {
          record = await this.#save(record, { phase: 'attempted', attempts: 1 });
          await this.#requireStable(record);
          input = await this.#bind(record, effect);
          await this.#effects.remove(input);
        }
      }

      if (record.phase === 'attempted') {
        let input = await this.#bind(record, effect);
        let observed = normalizeRemovalObservation(await this.#effects.observe(input), effect);
        if (observed.state === 'ambiguous') throw new Error('removal effect is ambiguous after attempt');
        if (observed.state === 'present') {
          if (!observed.retryable || record.attempts >= maximumRemovalAttempts()) {
            throw new Error('removal effect remains present after bounded reconciliation');
          }
          record = await this.#save(record, { attempts: record.attempts + 1 });
          await this.#requireStable(record);
          input = await this.#bind(record, effect);
          await this.#effects.remove(input);
          observed = normalizeRemovalObservation(await this.#effects.observe(input), effect);
          if (observed.state !== 'absent') throw new Error('removal effect did not reconcile after bounded retry');
        }
        const outcomes = [...record.outcomes];
        outcomes[record.cursor] = 'removed';
        record = await this.#save(record, { phase: 'observed', outcomes });
      }

      if (record.phase === 'observed') {
        const input = await this.#bind(record, effect);
        const observed = normalizeRemovalObservation(await this.#effects.observe(input), effect);
        if (observed.state !== 'absent') throw new Error('removal effect absence evidence changed');
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

export function createApplicationRemoval(options) {
  return new ApplicationRemoval(options);
}
