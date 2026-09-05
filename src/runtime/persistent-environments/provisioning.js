function requirePort(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} port must be a function`);
  return value;
}

function requireEffects(value) {
  const methods = ['binding', 'resolve', 'record', 'observe', 'provision', 'requireSource'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('provisioning effects port is incomplete');
  return value;
}

export class EnvironmentProvisioning {
  #effects;
  #commit;
  #present;
  #slotIdentity;
  #environmentIdentity;
  #operationIdentity;
  #sameSettings;
  #now;

  constructor({ effects, commit, present, slotIdentity, environmentIdentity, operationIdentity, sameSettings, now }) {
    this.#effects = requireEffects(effects);
    this.#commit = requirePort(commit, 'provisioning commit');
    this.#present = requirePort(present, 'provisioning presentation');
    this.#slotIdentity = requirePort(slotIdentity, 'provisioning slot identity');
    this.#environmentIdentity = requirePort(environmentIdentity, 'provisioning environment identity');
    this.#operationIdentity = requirePort(operationIdentity, 'provisioning operation identity');
    this.#sameSettings = requirePort(sameSettings, 'provisioning settings comparison');
    this.#now = requirePort(now, 'provisioning clock');
  }

  async #complete(state, operation) {
    const request = {
      subject: operation.subject,
      profile: operation.profile,
      sourceIdentity: operation.source.identity,
      settings: operation.settings,
    };
    const resolved = await this.#effects.resolve(request, operation.source);
    let observed = await this.#effects.observe(operation.identity);
    if (observed.exists) {
      if (!observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'existing environment conflicts with the intended provisioning effect');
      this.#effects.requireSource(observed, operation.source.identity);
    } else {
      observed = await this.#effects.provision({ identity: operation.identity, source: resolved, settings: operation.settings });
      if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment provisioning did not produce an owned compatible environment');
      this.#effects.requireSource(observed, operation.source.identity);
    }
    operation.state = 'attempted';
    operation.attemptedAt = this.#now();
    await this.#commit(state);

    state.entries[operation.slot] = {
      slot: operation.slot,
      binding: operation.binding,
      subject: operation.subject,
      profile: operation.profile,
      current: {
        identity: operation.identity,
        generation: operation.generation,
        source: operation.source,
        settings: operation.settings,
        createdAt: operation.plannedAt,
      },
      history: [],
    };
    operation.state = 'reconciled';
    operation.reconciledAt = this.#now();
    await this.#commit(state);
    return { record: this.#present(state.entries[operation.slot]), observation: observed };
  }

  async ensure(state, request) {
    const binding = await this.#effects.binding();
    const matching = Object.values(state.entries).find((entry) => entry.subject === request.subject && entry.profile === request.profile);
    if (matching) {
      if (matching.binding !== binding) throw new Error('environment attachment identity changed; existing state will not be silently reused');
      if (matching.current.source.identity !== request.sourceIdentity) throw new Error('environment source changed; explicit reseed is required');
      if (!this.#sameSettings(matching.current.settings, request.settings)) throw new Error('environment settings changed; explicit reset or reseed is required');
      await this.#effects.resolve(request, matching.current.source);
      const observed = await this.#effects.observe(matching.current.identity);
      if (!observed.exists || !observed.owned || !observed.compatible) {
        throw new Error(observed.reason ?? 'registered environment state is missing or incompatible; explicit recovery is required');
      }
      this.#effects.requireSource(observed, matching.current.source.identity);
      return { record: this.#present(matching), observation: observed };
    }

    const source = await this.#effects.resolve(request);
    const slot = this.#slotIdentity(binding, request.subject, request.profile);
    const generation = 1;
    const identity = this.#environmentIdentity(slot, generation, source.identity);
    const operationId = this.#operationIdentity();
    state.operations[operationId] = {
      id: operationId,
      kind: 'provision',
      state: 'planned',
      binding,
      slot,
      identity,
      generation,
      subject: request.subject,
      profile: request.profile,
      source: this.#effects.record(source),
      settings: request.settings,
      plannedAt: this.#now(),
    };
    await this.#commit(state);
    return this.#complete(state, state.operations[operationId]);
  }

  async resume(state, operation) {
    return this.#complete(state, operation);
  }
}
