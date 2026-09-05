function requirePort(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} port must be a function`);
  return value;
}

function requireEffects(value) {
  const methods = ['observe', 'stop', 'drop', 'requireSource', 'stopped'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('retirement effects port is incomplete');
  return value;
}

export class EnvironmentRetirement {
  #effects;
  #commit;
  #find;
  #operationIdentity;
  #now;

  constructor({ effects, commit, find, operationIdentity, now }) {
    this.#effects = requireEffects(effects);
    this.#commit = requirePort(commit, 'retirement commit');
    this.#find = requirePort(find, 'retirement lookup');
    this.#operationIdentity = requirePort(operationIdentity, 'retirement operation identity');
    this.#now = requirePort(now, 'retirement clock');
  }

  async retireSuperseded(state, binding, currentIdentity, oldIdentity) {
    const { entry } = this.#find(state, currentIdentity);
    if (entry.binding !== binding) throw new Error('environment attachment identity changed');
    if (entry.current.identity !== currentIdentity) throw new Error('environment retirement current implementation generation changed');
    const old = (entry.history ?? []).find((item) => item.identity === oldIdentity);
    if (!old) throw new Error('environment retirement subject is not an exact superseded generation');
    if (old.removedAt != null) return { identity: oldIdentity, removed: false, absent: true };
    const observed = await this.#effects.observe(oldIdentity);
    if (!observed.exists) {
      old.removedAt = this.#now();
      await this.#commit(state);
      return { identity: oldIdentity, removed: false, absent: true };
    }
    if (!observed.owned) throw new Error('environment superseded ownership evidence does not match');
    if (!this.#effects.stopped(observed.state)) throw new Error('environment superseded generation is not stopped for retirement');
    const removal = await this.#effects.drop(oldIdentity);
    if (!removal || (removal.removed !== true && removal.absent !== true)) throw new Error('environment superseded retirement did not reconcile');
    old.removedAt = this.#now();
    await this.#commit(state);
    return { identity: oldIdentity, removed: removal.removed === true, absent: removal.absent === true };
  }

  async #completeRemove(state, operation) {
    const found = Object.values(state.entries).find((entry) => entry.current?.identity === operation.identity);
    if (found) {
      let observed = await this.#effects.observe(operation.identity);
      if (observed.exists && (!observed.owned || !observed.compatible)) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
      if (observed.exists) this.#effects.requireSource(observed, found.current.source.identity);
      if (observed.exists && !this.#effects.stopped(observed.state)) {
        observed = await this.#effects.stop(operation.identity, { force: true, timeoutMs: 60_000 });
        this.#effects.requireSource(observed, found.current.source.identity);
      }
      const removal = await this.#effects.drop(operation.identity);
      if (!removal || (removal.removed !== true && removal.absent !== true)) throw new Error('environment removal did not reconcile');
      delete state.entries[operation.slot];
    } else {
      const removal = await this.#effects.drop(operation.identity);
      if (!removal || (removal.removed !== true && removal.absent !== true)) throw new Error('environment removal did not reconcile');
    }
    operation.state = 'reconciled';
    operation.reconciledAt = this.#now();
    await this.#commit(state);
    return { identity: operation.identity, removed: true };
  }

  async remove(state, binding, identity) {
    const { slot, entry } = this.#find(state, identity);
    if (entry.binding !== binding) throw new Error('environment attachment identity changed');
    const operationId = this.#operationIdentity();
    state.operations[operationId] = { id: operationId, kind: 'remove', state: 'planned', binding, slot, identity: entry.current.identity, plannedAt: this.#now() };
    await this.#commit(state);
    return this.#completeRemove(state, state.operations[operationId]);
  }

  async resumeRemove(state, operation) {
    return this.#completeRemove(state, operation);
  }
}
