export class ChatHandoffStoreTransaction {
  #channel;
  #maxBytes;
  #now;
  #ports;

  constructor({ channel, maxBytes, now, ports }) {
    if (!channel || !['read', 'write', 'list'].every((name) => typeof channel[name] === 'function')) throw new TypeError('transaction requires complete persistence ports');
    if (!ports || ![
      'normalizeSubject', 'buildValue', 'digestValue', 'describeValue', 'locate', 'verifyRecord', 'verifyPointer',
      'createPlanned', 'createReady', 'createReference', 'createPointer', 'recordOrder',
      'selectRemovals', 'seed', 'assertSubject', 'createPolicyError', 'createProtocolError',
    ].every((name) => typeof ports[name] === 'function')) throw new TypeError('transaction requires complete contract ports');
    this.#channel = channel;
    this.#maxBytes = maxBytes;
    this.#now = now;
    this.#ports = ports;
  }

  async #loadRef(ref) {
    if (!ref) return null;
    const raw = await this.#channel.read(ref.key);
    if (!raw) throw this.#ports.createProtocolError(`chat handoff record ${ref.key} is missing`);
    return this.#ports.verifyRecord(raw, { expectedDigest: ref.digest, expectedState: 'ready', maxBytes: this.#maxBytes });
  }

  #seed(record) { return this.#ports.seed(record, null, { maxBytes: this.#maxBytes }); }

  async loadLatest(subjectValue, { allowFallback = true } = {}) {
    const subject = this.#ports.normalizeSubject(subjectValue);
    const locations = this.#ports.locate(subject);
    const pointer = this.#ports.verifyPointer(await this.#channel.read(locations.pointer));
    if (!pointer?.current) return null;
    try {
      const record = await this.#loadRef(pointer.current);
      this.#ports.assertSubject(record, subject, false);
      return { record, ref: pointer.current, recoveredFromPrevious: false, seed: this.#seed(record) };
    } catch (error) {
      if (!allowFallback || !pointer.previous) throw error;
      const record = await this.#loadRef(pointer.previous);
      this.#ports.assertSubject(record, subject, true);
      return { record, ref: pointer.previous, recoveredFromPrevious: true, recoveryError: { name: error.name, message: error.message }, seed: this.#seed(record) };
    }
  }

  async checkpoint(input) {
    const handoff = this.#ports.buildValue(input, { now: this.#now, maxBytes: this.#maxBytes });
    const digest = this.#ports.digestValue(handoff, { maxBytes: this.#maxBytes });
    const descriptor = this.#ports.describeValue(handoff);
    const locations = this.#ports.locate(descriptor.subject);
    const pointer = this.#ports.verifyPointer(await this.#channel.read(locations.pointer));
    if (pointer?.current?.digest === digest) {
      const record = await this.#loadRef(pointer.current);
      return { record, ref: pointer.current, previousDigest: pointer.previous?.digest ?? null, idempotent: true, seed: this.#seed(record) };
    }
    if (pointer?.current && descriptor.order <= pointer.current.sequence) throw this.#ports.createPolicyError('chat handoff replacement sequence must advance beyond the current verified handoff');
    if (descriptor.previousIdentity && pointer?.current?.digest !== descriptor.previousIdentity) throw this.#ports.createPolicyError('chat handoff previousHandoffDigest does not match the current verified handoff');

    const recordKey = `${locations.records}${descriptor.order}.${digest.slice(0, 16)}`;
    const planned = this.#ports.createPlanned({ digest, handoff, createdAt: new Date(this.#now()).toISOString() });
    await this.#channel.write(recordKey, planned);
    this.#ports.verifyRecord(await this.#channel.read(recordKey), { expectedDigest: digest, expectedState: 'planned', maxBytes: this.#maxBytes });
    const ready = this.#ports.createReady(planned, new Date(this.#now()).toISOString());
    await this.#channel.write(recordKey, ready);
    const verified = this.#ports.verifyRecord(await this.#channel.read(recordKey), { expectedDigest: digest, expectedState: 'ready', maxBytes: this.#maxBytes });
    const ref = this.#ports.createReference({ key: recordKey, digest, sequence: descriptor.order, handoffId: descriptor.identity });
    const nextPointer = this.#ports.createPointer({ current: ref, previous: pointer?.current ?? pointer?.previous ?? null, updatedAt: new Date(this.#now()).toISOString() });
    await this.#channel.write(locations.pointer, nextPointer);
    const observedPointer = this.#ports.verifyPointer(await this.#channel.read(locations.pointer));
    if (observedPointer.current?.digest !== digest) throw this.#ports.createProtocolError('chat handoff pointer verification failed');
    await this.#loadRef(observedPointer.current);
    await this.#prune(locations, observedPointer);
    return { record: verified, ref, previousDigest: nextPointer.previous?.digest ?? null, idempotent: false, seed: this.#seed(verified) };
  }

  async #prune(locations, pointer) {
    const entries = await this.#channel.list(locations.records);
    const summaries = entries.map(([key, value]) => ({ key, order: this.#ports.recordOrder(value) }));
    const removals = this.#ports.selectRemovals(summaries, [pointer.current?.key, pointer.previous?.key]);
    if (typeof this.#channel.remove !== 'function') return;
    for (const key of removals) await this.#channel.remove(key);
  }
}
