function ensureActive(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('execution control signal was raised');
}

export class WorkspaceSession {
  #activity;
  #sourcePort;
  #inputPort;
  #operationPort;
  #outputPort;
  #candidatePort;
  #resourcePort;
  #identify;
  #close;
  #messages;
  #source = null;
  #evidence = null;

  constructor({ activity, source, input, operation, output, candidate, resource, identify, close, messages }) {
    this.#activity = activity;
    this.#sourcePort = source;
    this.#inputPort = input;
    this.#operationPort = operation;
    this.#outputPort = output;
    this.#candidatePort = candidate;
    this.#resourcePort = resource;
    this.#identify = identify;
    this.#close = close;
    this.#messages = { ...messages };
  }

  async prepare({ signal = null, onActivity = null } = {}) {
    ensureActive(signal);
    const ready = await this.#activity.prepare();
    ensureActive(signal);
    const health = await this.#activity.health();
    if (!health.ready) throw new Error(health.reason ?? this.#messages.activityUnavailable);
    this.#source = await this.#sourcePort.snapshot();
    ensureActive(signal);
    await this.#sourcePort.install();
    const observed = await this.#sourcePort.observe(this.#source.manifest.digest, { signal, onActivity });
    if (observed.appliedDigest !== this.#source.manifest.digest) {
      for (const entry of this.#source.manifest.entries) {
        if (entry.type !== 'file') continue;
        for (const part of entry.parts) {
          ensureActive(signal);
          await this.#sourcePort.writePart(part, (request) => this.#source.readPart(part.name, request));
        }
      }
      await this.#sourcePort.writeManifest(this.#source.manifestBytes());
      const applied = await this.#sourcePort.apply({ signal, onActivity });
      if (applied.digest !== this.#source.manifest.digest) throw new Error(this.#messages.sourceApplyMismatch);
    }
    const current = await this.#sourcePort.snapshot();
    if (current.manifest.digest !== this.#source.manifest.digest) throw new Error(this.#messages.sourceChangedDuringSync);
    this.#evidence = this.#identify({ generation: ready.generation, version: health.version, source: this.#source.manifest.digest });
    return { identity: this.#evidence };
  }

  async input(name, port, { signal = null } = {}) {
    ensureActive(signal);
    await this.#inputPort(name, port);
    ensureActive(signal);
  }

  async run({ invocation, environment, transfers = [], limits, stdin, signal = null, onActivity = null }) {
    if (!this.#source || !this.#evidence) throw new Error(this.#messages.notPrepared);
    const staged = await this.#operationPort.stage({ invocation, environment, stdin, transfers });
    return this.#operationPort.execute({
      location: staged.location,
      arguments: staged.arguments,
      directory: invocation.workingDirectory,
      limits,
      signal,
      onActivity,
    });
  }

  async output(name, port, { signal = null } = {}) {
    ensureActive(signal);
    await this.#outputPort(name, port);
    ensureActive(signal);
  }

  async collect({ identity, operation = null, signal = null } = {}) {
    ensureActive(signal);
    if (identity !== this.#evidence || !this.#source) throw new Error(this.#messages.evidenceChanged);
    const before = await this.#sourcePort.snapshot();
    if (before.manifest.digest !== this.#source.manifest.digest) throw new Error(this.#messages.sourceChangedDuringWork);
    if (!this.#candidatePort.accepts(operation)) return;
    await this.#candidatePort.collect({ signal });
    const manifest = await this.#candidatePort.readManifest();
    if (manifest.basisDigest !== this.#source.manifest.digest) throw new Error(this.#messages.staleCandidate);
    const stage = await this.#candidatePort.createStage();
    try {
      const staged = await this.#candidatePort.stage({
        manifest,
        stage,
        signal,
        active: () => ensureActive(signal),
      });
      ensureActive(signal);
      const current = await this.#sourcePort.snapshot();
      if (current.manifest.digest !== this.#source.manifest.digest) throw new Error(this.#messages.sourceChangedBeforeApply);
      ensureActive(signal);
      await this.#candidatePort.apply({ manifest: staged, stage, signal });
    } finally {
      await this.#candidatePort.discard(stage);
    }
  }

  async cleanup({ resource, signal = null } = {}) {
    ensureActive(signal);
    this.#resourcePort.assert(resource);
    const ready = await this.#activity.prepare();
    ensureActive(signal);
    const health = await this.#activity.health();
    if (!health.ready) throw new Error(health.reason ?? this.#messages.activityUnavailable);
    const observed = await this.#resourcePort.remove(resource, { signal });
    if (observed.state !== 'verified-absent' || typeof observed.removed !== 'boolean') throw new Error(this.#messages.cleanupUnverified);
    return {
      state: observed.state,
      removed: observed.removed,
      identity: this.#identify({ generation: ready.generation, version: health.version, resource }),
    };
  }

  async close() {
    await this.#close();
  }
}
