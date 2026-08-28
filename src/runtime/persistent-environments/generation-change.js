function requirePort(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} port must be a function`);
  return value;
}

function requireEffects(value) {
  const methods = ['resolve', 'record', 'observe', 'provision', 'stop', 'quiesce', 'canQuiesce', 'drop', 'requireSource', 'stopped'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('generation effects port is incomplete');
  return value;
}

export class EnvironmentGenerationChange {
  #effects;
  #commit;
  #present;
  #find;
  #environmentIdentity;
  #operationIdentity;
  #now;

  constructor({ effects, commit, present, find, environmentIdentity, operationIdentity, now }) {
    this.#effects = requireEffects(effects);
    this.#commit = requirePort(commit, 'generation commit');
    this.#present = requirePort(present, 'generation presentation');
    this.#find = requirePort(find, 'generation lookup');
    this.#environmentIdentity = requirePort(environmentIdentity, 'generation environment identity');
    this.#operationIdentity = requirePort(operationIdentity, 'generation operation identity');
    this.#now = requirePort(now, 'generation clock');
  }

  async #observeEntry(entry) {
    const observation = await this.#effects.observe(entry.current.identity);
    if (observation.exists && observation.owned && observation.compatible) this.#effects.requireSource(observation, entry.current.source.identity);
    return { record: this.#present(entry), observation };
  }

  async #completeRotate(state, operation) {
    const found = Object.values(state.entries).find((entry) => entry.slot === operation.slot);
    if (!found) throw new Error('environment rotation subject disappeared');
    if (found.current.identity !== operation.oldIdentity && found.current.identity !== operation.newIdentity) throw new Error('environment rotation subject changed unexpectedly');

    if (found.current.identity === operation.oldIdentity) {
      let oldObserved = await this.#effects.observe(operation.oldIdentity);
      if (!oldObserved.exists || !oldObserved.owned || !oldObserved.compatible) throw new Error(oldObserved.reason ?? 'current environment is unavailable for reset');
      this.#effects.requireSource(oldObserved, operation.oldSource.identity);
      if (!this.#effects.stopped(oldObserved.state)) oldObserved = await this.#effects.stop(operation.oldIdentity, { force: true, timeoutMs: 60_000 });
      if (!this.#effects.stopped(oldObserved.state)) throw new Error('current environment did not stop before rotation');
      this.#effects.requireSource(oldObserved, operation.oldSource.identity);

      const request = { subject: found.subject, profile: found.profile, sourceIdentity: operation.source.identity, settings: operation.settings };
      const resolved = await this.#effects.resolve(request, operation.source);
      let nextObserved = await this.#effects.observe(operation.newIdentity);
      if (nextObserved.exists) {
        if (!nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'existing replacement environment conflicts with the intended rotation');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      } else {
        nextObserved = await this.#effects.provision({ identity: operation.newIdentity, source: resolved, settings: operation.settings });
        if (!nextObserved.exists || !nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'replacement environment did not provision compatibly');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      }
      operation.state = 'attempted';
      operation.attemptedAt = this.#now();
      await this.#commit(state);

      found.history ??= [];
      found.history.push({ ...found.current, supersededAt: this.#now(), removedAt: null });
      found.current = {
        identity: operation.newIdentity,
        generation: operation.generation,
        source: operation.source,
        settings: operation.settings,
        createdAt: operation.plannedAt,
      };
      operation.state = 'switched';
      operation.switchedAt = this.#now();
      await this.#commit(state);
    }

    const removal = await this.#effects.drop(operation.oldIdentity);
    if (!removal || (removal.removed !== true && removal.absent !== true)) throw new Error('superseded environment removal did not reconcile');
    const old = (found.history ?? []).find((item) => item.identity === operation.oldIdentity);
    if (old && old.removedAt == null) old.removedAt = this.#now();
    operation.state = 'reconciled';
    operation.reconciledAt = this.#now();
    await this.#commit(state);
    return this.#observeEntry(found);
  }

  async rotate(state, binding, identity, sourceIdentity = null) {
    const { slot, entry } = this.#find(state, identity);
    if (entry.binding !== binding) throw new Error('environment attachment identity changed');
    const request = {
      subject: entry.subject,
      profile: entry.profile,
      sourceIdentity: sourceIdentity ?? entry.current.source.identity,
      settings: entry.current.settings,
    };
    const resolved = await this.#effects.resolve(request, sourceIdentity == null ? entry.current.source : null);
    const generation = Number(entry.current.generation) + 1;
    const newIdentity = this.#environmentIdentity(slot, generation, resolved.identity);
    const operationId = this.#operationIdentity();
    state.operations[operationId] = {
      id: operationId,
      kind: 'rotate',
      state: 'planned',
      binding,
      slot,
      oldIdentity: entry.current.identity,
      newIdentity,
      generation,
      source: this.#effects.record(resolved),
      oldSource: structuredClone(entry.current.source),
      settings: entry.current.settings,
      plannedAt: this.#now(),
    };
    await this.#commit(state);
    return this.#completeRotate(state, state.operations[operationId]);
  }

  async resumeRotate(state, operation) {
    return this.#completeRotate(state, operation);
  }

  async #completeReplacement(state, operation) {
    const found = Object.values(state.entries).find((entry) => entry.slot === operation.slot);
    if (!found) throw new Error('environment replacement subject disappeared');
    if (found.current.identity !== operation.oldIdentity && found.current.identity !== operation.newIdentity) throw new Error('environment replacement subject changed unexpectedly');

    if (found.current.identity === operation.oldIdentity) {
      let oldObserved = await this.#effects.observe(operation.oldIdentity);
      if (!oldObserved.exists) throw new Error('environment provider implementation is missing; recreate is required');
      if (!oldObserved.owned) throw new Error('environment ownership evidence does not match');
      if (!this.#effects.stopped(oldObserved.state)) {
        oldObserved = await this.#effects.stop(operation.oldIdentity, { force: true, timeoutMs: 60_000 });
        if (!oldObserved.exists) throw new Error('environment provider implementation disappeared while stopping');
        if (!oldObserved.owned) throw new Error('environment ownership evidence changed while stopping');
        if (!this.#effects.stopped(oldObserved.state)) throw new Error('environment did not stop before replacement');
      }

      const request = { subject: found.subject, profile: found.profile, sourceIdentity: operation.source.identity, settings: operation.settings };
      const resolved = await this.#effects.resolve(request, operation.source);
      let nextObserved = await this.#effects.observe(operation.newIdentity);
      if (nextObserved.exists) {
        if (!nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'existing replacement environment conflicts with the intended replacement');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      } else {
        nextObserved = await this.#effects.provision({ identity: operation.newIdentity, source: resolved, settings: operation.settings });
        if (!nextObserved.exists || !nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'replacement environment did not provision compatibly');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      }
      operation.state = 'attempted';
      operation.attemptedAt = this.#now();
      await this.#commit(state);

      found.history ??= [];
      found.history.push({ ...found.current, supersededAt: this.#now(), removedAt: null });
      found.current = {
        identity: operation.newIdentity,
        generation: operation.generation,
        source: operation.source,
        settings: operation.settings,
        createdAt: operation.plannedAt,
      };
      operation.state = 'switched';
      operation.switchedAt = this.#now();
      await this.#commit(state);
    }

    operation.state = 'reconciled';
    operation.reconciledAt = this.#now();
    await this.#commit(state);
    const current = await this.#observeEntry(found);
    return { ...current, superseded: { identity: operation.oldIdentity, cleanup: 'retained' } };
  }

  async replace(state, binding, identity, requestIdentity, expectedPrevious) {
    const prior = Object.values(state.operations).find((operation) => operation.kind === 'replace' && operation.requestId === requestIdentity);
    if (prior) {
      if (prior.binding !== binding) throw new Error('environment attachment identity changed; pending replacement will not be replayed');
      if (prior.oldIdentity !== expectedPrevious) throw new Error('environment replacement request no longer matches its previous implementation generation');
      if (![prior.oldIdentity, prior.newIdentity].includes(identity)) throw new Error('environment replacement request identity is stale');
      return this.#completeReplacement(state, prior);
    }
    const { slot, entry } = this.#find(state, identity);
    if (entry.binding !== binding) throw new Error('environment attachment identity changed');
    if (entry.current.identity !== expectedPrevious) throw new Error('environment replacement previous implementation generation changed');
    const preflight = await this.#effects.observe(entry.current.identity);
    if (!preflight.exists) throw new Error('environment provider implementation is missing; recreate is required');
    if (!preflight.owned) throw new Error('environment ownership evidence does not match');
    const request = { subject: entry.subject, profile: entry.profile, sourceIdentity: entry.current.source.identity, settings: entry.current.settings };
    const resolved = await this.#effects.resolve(request, entry.current.source);
    const generation = Number(entry.current.generation) + 1;
    const newIdentity = this.#environmentIdentity(slot, generation, resolved.identity);
    const operationId = this.#operationIdentity();
    state.operations[operationId] = {
      id: operationId,
      kind: 'replace',
      requestId: requestIdentity,
      state: 'planned',
      binding,
      slot,
      oldIdentity: entry.current.identity,
      newIdentity,
      generation,
      source: this.#effects.record(resolved),
      oldSource: structuredClone(entry.current.source),
      settings: entry.current.settings,
      plannedAt: this.#now(),
    };
    await this.#commit(state);
    return this.#completeReplacement(state, state.operations[operationId]);
  }

  async #completeRecreate(state, operation) {
    const found = Object.values(state.entries).find((entry) => entry.slot === operation.slot);
    if (!found) throw new Error('environment recreate subject disappeared');
    if (found.current.identity !== operation.oldIdentity && found.current.identity !== operation.newIdentity) throw new Error('environment recreate subject changed unexpectedly');

    if (found.current.identity === operation.oldIdentity) {
      let oldObserved = await this.#effects.observe(operation.oldIdentity);
      if (oldObserved.exists) {
        if (!oldObserved.owned) throw new Error('environment recreate ownership evidence does not match');
        if (!this.#effects.stopped(oldObserved.state)) {
          oldObserved = await this.#effects.stop(operation.oldIdentity, { force: true, timeoutMs: 60_000 });
          if (!oldObserved.exists) throw new Error('environment recreate provider implementation disappeared while stopping');
          if (!oldObserved.owned) throw new Error('environment recreate ownership evidence changed while stopping');
          if (!this.#effects.stopped(oldObserved.state)) throw new Error('environment recreate provider implementation did not stop');
        }
        operation.previousProvider = 'retained';
      } else {
        operation.previousProvider = 'absent';
      }

      const request = { subject: found.subject, profile: found.profile, sourceIdentity: operation.source.identity, settings: operation.settings };
      const resolved = await this.#effects.resolve(request, operation.source);
      let nextObserved = await this.#effects.observe(operation.newIdentity);
      if (nextObserved.exists) {
        if (!nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'existing recreate generation conflicts with the intended replacement');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      } else {
        nextObserved = await this.#effects.provision({ identity: operation.newIdentity, source: resolved, settings: operation.settings });
        if (!nextObserved.exists || !nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'recreate replacement environment did not provision compatibly');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      }
      operation.state = 'attempted';
      operation.attemptedAt = this.#now();
      await this.#commit(state);

      const supersededAt = this.#now();
      found.history ??= [];
      found.history.push({ ...found.current, supersededAt, removedAt: operation.previousProvider === 'absent' ? supersededAt : null });
      found.current = {
        identity: operation.newIdentity,
        generation: operation.generation,
        source: operation.source,
        settings: operation.settings,
        createdAt: operation.plannedAt,
      };
      operation.state = 'switched';
      operation.switchedAt = this.#now();
      await this.#commit(state);
    }

    const old = (found.history ?? []).find((item) => item.identity === operation.oldIdentity);
    const cleanup = old?.removedAt == null ? 'retained' : 'absent';
    operation.previousProvider = cleanup;
    operation.state = 'reconciled';
    operation.reconciledAt = this.#now();
    await this.#commit(state);
    const current = await this.#observeEntry(found);
    return { ...current, superseded: { identity: operation.oldIdentity, cleanup } };
  }

  async recreate(state, binding, identity, requestIdentity, expectedPrevious) {
    const prior = Object.values(state.operations).find((operation) => operation.kind === 'recreate' && operation.requestId === requestIdentity);
    if (prior) {
      if (prior.binding !== binding) throw new Error('environment attachment identity changed; pending recreate will not be replayed');
      if (prior.oldIdentity !== expectedPrevious) throw new Error('environment recreate request no longer matches its previous implementation generation');
      if (![prior.oldIdentity, prior.newIdentity].includes(identity)) throw new Error('environment recreate request identity is stale');
      return this.#completeRecreate(state, prior);
    }
    const { slot, entry } = this.#find(state, identity);
    if (entry.binding !== binding) throw new Error('environment attachment identity changed');
    if (entry.current.identity !== expectedPrevious) throw new Error('environment recreate previous implementation generation changed');
    const preflight = await this.#effects.observe(entry.current.identity);
    if (preflight.exists && !preflight.owned) throw new Error('environment recreate ownership evidence does not match');
    const request = { subject: entry.subject, profile: entry.profile, sourceIdentity: entry.current.source.identity, settings: entry.current.settings };
    const resolved = await this.#effects.resolve(request, entry.current.source);
    const generation = Number(entry.current.generation) + 1;
    const newIdentity = this.#environmentIdentity(slot, generation, resolved.identity);
    const operationId = this.#operationIdentity();
    state.operations[operationId] = {
      id: operationId,
      kind: 'recreate',
      requestId: requestIdentity,
      state: 'planned',
      binding,
      slot,
      oldIdentity: entry.current.identity,
      newIdentity,
      generation,
      source: this.#effects.record(resolved),
      oldSource: structuredClone(entry.current.source),
      settings: entry.current.settings,
      previousProvider: preflight.exists ? 'retained' : 'absent',
      plannedAt: this.#now(),
    };
    await this.#commit(state);
    return this.#completeRecreate(state, state.operations[operationId]);
  }

  async #completeRebuild(state, operation) {
    const found = Object.values(state.entries).find((entry) => entry.slot === operation.slot);
    if (!found) throw new Error('environment rebuild subject disappeared');
    if (found.current.identity !== operation.oldIdentity && found.current.identity !== operation.newIdentity) throw new Error('environment rebuild subject changed unexpectedly');

    if (found.current.identity === operation.oldIdentity) {
      let oldObserved = await this.#effects.observe(operation.oldIdentity);
      if (!oldObserved.exists) throw new Error('environment provider implementation is missing; recreate is required');
      if (!oldObserved.owned) throw new Error('environment ownership evidence does not match');
      if (oldObserved.compatible || !['absent', 'invalid'].includes(oldObserved.storageState)) {
        throw new Error('environment rebuild requires missing or invalid system storage');
      }
      if (!this.#effects.stopped(oldObserved.state)) {
        if (!this.#effects.canQuiesce()) throw new Error('degraded environment is still running and cannot be safely quiesced for rebuild');
        oldObserved = await this.#effects.quiesce(operation.oldIdentity);
        if (!oldObserved.exists) throw new Error('environment provider implementation disappeared while quiescing');
        if (!oldObserved.owned) throw new Error('environment ownership evidence changed while quiescing');
        if (!this.#effects.stopped(oldObserved.state)) throw new Error('degraded environment did not quiesce before rebuild');
      }

      const request = { subject: found.subject, profile: found.profile, sourceIdentity: operation.source.identity, settings: operation.settings };
      const resolved = await this.#effects.resolve(request, operation.source);
      let nextObserved = await this.#effects.observe(operation.newIdentity);
      if (nextObserved.exists) {
        if (!nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'existing rebuild generation conflicts with the intended replacement');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      } else {
        nextObserved = await this.#effects.provision({ identity: operation.newIdentity, source: resolved, settings: operation.settings });
        if (!nextObserved.exists || !nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'replacement environment did not provision compatibly');
        this.#effects.requireSource(nextObserved, operation.source.identity);
      }
      operation.state = 'attempted';
      operation.attemptedAt = this.#now();
      await this.#commit(state);

      found.history ??= [];
      found.history.push({ ...found.current, supersededAt: this.#now(), removedAt: null });
      found.current = {
        identity: operation.newIdentity,
        generation: operation.generation,
        source: operation.source,
        settings: operation.settings,
        createdAt: operation.plannedAt,
      };
      operation.state = 'switched';
      operation.switchedAt = this.#now();
      await this.#commit(state);
    }

    const historical = (found.history ?? []).find((item) => item.identity === operation.oldIdentity);
    let cleanup = operation.cleanup ?? 'retained';
    try {
      const oldObserved = await this.#effects.observe(operation.oldIdentity);
      cleanup = oldObserved.exists ? 'retained' : 'absent';
    } catch {
      cleanup = 'retained';
    }
    if (historical && cleanup === 'absent' && historical.removedAt == null) historical.removedAt = this.#now();
    operation.cleanup = cleanup;
    operation.state = 'reconciled';
    operation.reconciledAt = this.#now();
    await this.#commit(state);
    const current = await this.#observeEntry(found);
    return { ...current, superseded: { identity: operation.oldIdentity, cleanup } };
  }

  async rebuild(state, binding, identity, requestIdentity, expectedPrevious) {
    const prior = Object.values(state.operations).find((operation) => operation.kind === 'rebuild' && operation.requestId === requestIdentity);
    if (prior) {
      if (prior.binding !== binding) throw new Error('environment attachment identity changed; pending rebuild will not be replayed');
      if (prior.oldIdentity !== expectedPrevious) throw new Error('environment rebuild request no longer matches its previous implementation generation');
      if (![prior.oldIdentity, prior.newIdentity].includes(identity)) throw new Error('environment rebuild request identity is stale');
      return this.#completeRebuild(state, prior);
    }
    const { slot, entry } = this.#find(state, identity);
    if (entry.binding !== binding) throw new Error('environment attachment identity changed');
    if (entry.current.identity !== expectedPrevious) throw new Error('environment rebuild previous implementation generation changed');
    const preflight = await this.#effects.observe(entry.current.identity);
    if (!preflight.exists) throw new Error('environment provider implementation is missing; recreate is required');
    if (!preflight.owned) throw new Error('environment ownership evidence does not match');
    if (preflight.compatible || !['absent', 'invalid'].includes(preflight.storageState)) {
      throw new Error('environment rebuild requires missing or invalid system storage');
    }
    if (!this.#effects.stopped(preflight.state) && !this.#effects.canQuiesce()) {
      throw new Error('degraded environment is still running and cannot be safely quiesced for rebuild');
    }
    const request = { subject: entry.subject, profile: entry.profile, sourceIdentity: entry.current.source.identity, settings: entry.current.settings };
    const resolved = await this.#effects.resolve(request, entry.current.source);
    const generation = Number(entry.current.generation) + 1;
    const newIdentity = this.#environmentIdentity(slot, generation, resolved.identity);
    const operationId = this.#operationIdentity();
    state.operations[operationId] = {
      id: operationId,
      kind: 'rebuild',
      requestId: requestIdentity,
      state: 'planned',
      binding,
      slot,
      oldIdentity: entry.current.identity,
      newIdentity,
      generation,
      source: this.#effects.record(resolved),
      oldSource: structuredClone(entry.current.source),
      settings: entry.current.settings,
      cleanup: null,
      plannedAt: this.#now(),
    };
    await this.#commit(state);
    return this.#completeRebuild(state, state.operations[operationId]);
  }
}
