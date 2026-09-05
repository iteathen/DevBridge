function requirePort(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} port must be a function`);
  return value;
}

function requireEffects(value) {
  const methods = ['observe', 'start', 'stop', 'requireSource', 'stopped', 'running'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('lifecycle effects port is incomplete');
  return value;
}

function unavailable(entry) {
  return {
    record: null,
    observation: {
      identity: entry.current.identity,
      exists: false,
      owned: false,
      compatible: false,
      state: 'unavailable',
      reason: 'environment attachment identity changed',
      storage: null,
      storageState: 'unknown',
    },
  };
}

export class EnvironmentOrdinaryLifecycle {
  #effects;
  #commit;
  #present;
  #find;
  #operationIdentity;
  #now;

  constructor({ effects, commit, present, find, operationIdentity, now }) {
    this.#effects = requireEffects(effects);
    this.#commit = requirePort(commit, 'lifecycle commit');
    this.#present = requirePort(present, 'lifecycle presentation');
    this.#find = requirePort(find, 'lifecycle lookup');
    this.#operationIdentity = requirePort(operationIdentity, 'lifecycle operation identity');
    this.#now = requirePort(now, 'lifecycle clock');
  }

  async #observeEntry(entry) {
    const observation = await this.#effects.observe(entry.current.identity);
    if (observation.exists && observation.owned && observation.compatible) this.#effects.requireSource(observation, entry.current.source.identity);
    return { record: this.#present(entry), observation };
  }

  async list(state, binding) {
    const values = [];
    for (const entry of Object.values(state.entries)) {
      if (entry.binding !== binding) {
        const value = unavailable(entry);
        value.record = this.#present(entry);
        values.push(value);
      } else {
        values.push(await this.#observeEntry(entry));
      }
    }
    return values;
  }

  async observe(state, binding, identity) {
    const { entry } = this.#find(state, identity);
    if (entry.binding !== binding) {
      const value = unavailable(entry);
      value.record = this.#present(entry);
      return value;
    }
    return this.#observeEntry(entry);
  }

  async #complete(state, operation) {
    const entry = Object.values(state.entries).find((candidate) => candidate.current?.identity === operation.identity);
    if (!entry) throw new Error('environment transition subject disappeared');
    let observed = await this.#effects.observe(operation.identity);
    if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment is unavailable for lifecycle transition');
    this.#effects.requireSource(observed, entry.current.source.identity);
    const stopped = this.#effects.stopped(observed.state);
    const running = this.#effects.running(observed.state);
    if (operation.kind === 'start' && !running) observed = await this.#effects.start(operation.identity);
    if (operation.kind === 'stop' && !stopped) observed = await this.#effects.stop(operation.identity, operation.options ?? {});
    if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment lifecycle transition did not preserve an owned compatible environment');
    this.#effects.requireSource(observed, entry.current.source.identity);
    operation.state = 'reconciled';
    operation.reconciledAt = this.#now();
    await this.#commit(state);
    return observed;
  }

  async transition(state, binding, kind, identity, options = {}) {
    const { entry } = this.#find(state, identity);
    if (entry.binding !== binding) throw new Error('environment attachment identity changed');
    const operationId = this.#operationIdentity();
    state.operations[operationId] = { id: operationId, kind, state: 'planned', binding, identity: entry.current.identity, options, plannedAt: this.#now() };
    await this.#commit(state);
    const observation = await this.#complete(state, state.operations[operationId]);
    return { record: this.#present(entry), observation };
  }

  async resume(state, operation) {
    return this.#complete(state, operation);
  }
}
