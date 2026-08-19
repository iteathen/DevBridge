import { randomBytes } from 'node:crypto';
import { PolicyError, TaskLeaseLostError } from '../errors.js';
import { signTaskLease, taskLeaseExpired, verifySignedTaskLease } from './task-lease.js';

function taskKey(task) {
  return `${task.queueRepository}#${task.issueNumber}.${task.revision}`;
}

function defaultSetInterval(callback, intervalMs) {
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  return timer;
}

function boundedError(error) {
  const message = String(error?.message ?? error ?? 'task lease renewal failed').replace(/[\r\n\t]+/gu, ' ').trim();
  return { name: error?.name ?? 'Error', message: message.length <= 500 ? message : `${message.slice(0, 497)}...` };
}

export class TaskLeaseManager {
  #identity;
  #trusted;
  #store;
  #ttlMs;
  #heartbeatMs;
  #clockSkewMs;
  #allowIdentityTakeover;
  #nowMs;
  #setInterval;
  #clearInterval;
  #sessionId;
  #handles = new Map();

  constructor({
    identity,
    trustedIdentities = new Map(),
    store,
    leaseTtlMs,
    heartbeatIntervalMs,
    clockSkewMs = 0,
    allowIdentityTakeover = false,
    nowMs = () => Date.now(),
    setIntervalFn = defaultSetInterval,
    clearIntervalFn = clearInterval,
    sessionId = randomBytes(16).toString('hex'),
  }) {
    if (!identity || typeof identity.sign !== 'function' || typeof identity.fingerprint !== 'string') throw new TypeError('TaskLeaseManager requires a local agent identity');
    if (!store || typeof store.observe !== 'function' || typeof store.compareAndSwap !== 'function') throw new TypeError('TaskLeaseManager requires a lease store');
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1) throw new TypeError('TaskLeaseManager leaseTtlMs must be a positive safe integer');
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs >= leaseTtlMs) throw new TypeError('TaskLeaseManager heartbeatIntervalMs must be positive and less than leaseTtlMs');
    if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs >= leaseTtlMs) throw new TypeError('TaskLeaseManager clockSkewMs must be non-negative and less than leaseTtlMs');
    if (typeof allowIdentityTakeover !== 'boolean') throw new TypeError('TaskLeaseManager allowIdentityTakeover must be a boolean');
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/u.test(sessionId)) throw new TypeError('TaskLeaseManager sessionId must be 16 random bytes encoded as lowercase hex');
    this.#identity = identity;
    this.#trusted = new Map(trustedIdentities instanceof Map ? trustedIdentities : Object.entries(trustedIdentities ?? {}));
    this.#trusted.set(identity.fingerprint, identity);
    this.#store = store;
    this.#ttlMs = leaseTtlMs;
    this.#heartbeatMs = heartbeatIntervalMs;
    this.#clockSkewMs = clockSkewMs;
    this.#allowIdentityTakeover = allowIdentityTakeover;
    this.#nowMs = nowMs;
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
    this.#sessionId = sessionId;
  }

  get sessionId() { return this.#sessionId; }

  #verifyObservation(task, observation) {
    if (!observation?.commitSha || !observation.envelope) return null;
    const verified = verifySignedTaskLease(observation.envelope, {
      trustedIdentities: this.#trusted,
      queueRepository: task.queueRepository,
      issueNumber: task.issueNumber,
      taskRevision: task.revision,
    });
    const subject = verified.subject;
    const now = this.#nowMs();
    const issued = Date.parse(subject.issuedAt);
    if (issued > now + this.#clockSkewMs) throw new PolicyError('task lease issuance time is too far in the future');
    if (subject.state === 'active') {
      const duration = Date.parse(subject.expiresAt) - issued;
      if (duration <= 0 || duration > this.#ttlMs) throw new PolicyError('task lease duration exceeds local coordination policy');
    }
    return verified;
  }

  #transitionSubject(task, current, state) {
    const now = this.#nowMs();
    const previous = current?.commitSha ?? null;
    return signTaskLease(this.#identity, {
      queueRepository: task.queueRepository,
      issueNumber: task.issueNumber,
      taskRevision: task.revision,
      sessionId: this.#sessionId,
      epoch: (current?.envelope?.subject?.epoch ?? 0) + 1,
      state,
      issuedAt: new Date(now).toISOString(),
      expiresAt: state === 'active' ? new Date(now + this.#ttlMs).toISOString() : null,
      previousLeaseSha: previous,
    });
  }

  #fence(handle, message) {
    if (handle.fenced) return;
    handle.fenced = true;
    handle.fencedAt = new Date(this.#nowMs()).toISOString();
    handle.fenceReason = message;
    if (handle.timer) {
      this.#clearInterval(handle.timer);
      handle.timer = null;
    }
    const error = new TaskLeaseLostError(message);
    handle.abortController.abort(error);
  }

  #assertCurrent(handle) {
    if (!handle || handle.manager !== this) throw new TypeError('task lease handle does not belong to this manager');
    if (handle.released) throw new TaskLeaseLostError('task lease has already been released');
    if (handle.fenced) throw new TaskLeaseLostError(handle.fenceReason ?? 'task lease has been fenced');
    if (this.#nowMs() > Date.parse(handle.expiresAt)) {
      this.#fence(handle, 'task lease expired before the next authorized effect');
      throw new TaskLeaseLostError(handle.fenceReason);
    }
    return handle;
  }

  assertOwned(handle) {
    return this.#assertCurrent(handle);
  }

  #startHeartbeat(handle) {
    if (handle.timer || handle.fenced || handle.released) return;
    handle.timer = this.#setInterval(() => {
      handle.renewing = handle.renewing
        .then(() => this.renew(handle))
        .catch((error) => {
          handle.lastRenewalError = { ...boundedError(error), at: new Date(this.#nowMs()).toISOString() };
          if (this.#nowMs() > Date.parse(handle.expiresAt)) this.#fence(handle, 'task lease renewal failed until the signed lease expired');
        });
    }, this.#heartbeatMs);
  }

  stopHeartbeat(handle) {
    if (!handle || handle.manager !== this) throw new TypeError('task lease handle does not belong to this manager');
    if (handle.timer) {
      this.#clearInterval(handle.timer);
      handle.timer = null;
    }
  }

  async ensureFresh(handle) {
    this.#assertCurrent(handle);
    handle.renewing = handle.renewing.then(() => this.renew(handle));
    const result = await handle.renewing;
    this.#assertCurrent(handle);
    return result;
  }

  async begin(task) {
    const key = taskKey(task);
    const existingHandle = this.#handles.get(key);
    if (existingHandle && !existingHandle.fenced && !existingHandle.released) {
      this.#assertCurrent(existingHandle);
      this.#startHeartbeat(existingHandle);
      return { acquired: true, handle: existingHandle, reconciled: true };
    }

    const current = await this.#store.observe(task);
    const verified = this.#verifyObservation(task, current);
    const activeUnexpired = verified?.subject?.state === 'active' &&
      !taskLeaseExpired(verified.subject, this.#nowMs(), this.#clockSkewMs);
    if (activeUnexpired && verified.subject.ownerFingerprint !== this.#identity.fingerprint) {
      return {
        acquired: false,
        reason: 'held-by-peer',
        ownerAddress: verified.subject.ownerAddress,
        expiresAt: verified.subject.expiresAt,
        epoch: verified.subject.epoch,
        commitSha: current.commitSha,
      };
    }
    if (activeUnexpired && verified.subject.ownerFingerprint === this.#identity.fingerprint &&
        verified.subject.sessionId !== this.#sessionId && !this.#allowIdentityTakeover) {
      return {
        acquired: false,
        reason: 'held-by-local-session',
        ownerAddress: verified.subject.ownerAddress,
        expiresAt: verified.subject.expiresAt,
        epoch: verified.subject.epoch,
        commitSha: current.commitSha,
      };
    }

    const envelope = this.#transitionSubject(task, current, 'active');
    const swapped = await this.#store.compareAndSwap(task, { expectedSha: current?.commitSha ?? null, envelope });
    if (!swapped.updated) {
      const latest = swapped.current ?? await this.#store.observe(task);
      const latestVerified = this.#verifyObservation(task, latest);
      return {
        acquired: false,
        reason: 'cas-lost',
        ownerAddress: latestVerified?.subject?.ownerAddress ?? null,
        expiresAt: latestVerified?.subject?.expiresAt ?? null,
        epoch: latestVerified?.subject?.epoch ?? null,
        commitSha: latest?.commitSha ?? null,
      };
    }

    const abortController = new AbortController();
    const handle = {
      manager: this,
      task: structuredClone(task),
      key,
      commitSha: swapped.commitSha,
      epoch: envelope.subject.epoch,
      expiresAt: envelope.subject.expiresAt,
      abortController,
      signal: abortController.signal,
      timer: null,
      renewing: Promise.resolve(),
      fenced: false,
      fencedAt: null,
      fenceReason: null,
      released: false,
      lastRenewalError: null,
    };
    this.#handles.set(key, handle);
    this.#startHeartbeat(handle);
    return { acquired: true, handle, reconciled: verified?.subject?.ownerFingerprint === this.#identity.fingerprint };
  }

  async renew(handle) {
    this.#assertCurrent(handle);
    const current = { commitSha: handle.commitSha, envelope: { subject: { epoch: handle.epoch } } };
    const envelope = this.#transitionSubject(handle.task, current, 'active');
    let swapped;
    try {
      swapped = await this.#store.compareAndSwap(handle.task, { expectedSha: handle.commitSha, envelope });
    } catch (error) {
      if (this.#nowMs() > Date.parse(handle.expiresAt)) this.#fence(handle, 'task lease renewal failed until the signed lease expired');
      throw error;
    }
    if (!swapped.updated) {
      const latest = swapped.current ?? await this.#store.observe(handle.task);
      const verified = this.#verifyObservation(handle.task, latest);
      this.#fence(handle, `task lease CAS was lost${verified?.subject?.ownerAddress ? ` to ${verified.subject.ownerAddress}` : ''}`);
      return { renewed: false, reason: 'cas-lost', current: latest };
    }
    handle.commitSha = swapped.commitSha;
    handle.epoch = envelope.subject.epoch;
    handle.expiresAt = envelope.subject.expiresAt;
    handle.lastRenewalError = null;
    return { renewed: true, commitSha: handle.commitSha, epoch: handle.epoch, expiresAt: handle.expiresAt };
  }

  async release(handle) {
    this.#assertCurrent(handle);
    this.stopHeartbeat(handle);
    await handle.renewing;
    this.#assertCurrent(handle);
    const current = { commitSha: handle.commitSha, envelope: { subject: { epoch: handle.epoch } } };
    const envelope = this.#transitionSubject(handle.task, current, 'released');
    const swapped = await this.#store.compareAndSwap(handle.task, { expectedSha: handle.commitSha, envelope });
    if (!swapped.updated) {
      const latest = swapped.current ?? await this.#store.observe(handle.task);
      const verified = this.#verifyObservation(handle.task, latest);
      this.#fence(handle, `task lease release CAS was lost${verified?.subject?.ownerAddress ? ` to ${verified.subject.ownerAddress}` : ''}`);
      this.#handles.delete(handle.key);
      return { released: false, reason: 'cas-lost', current: latest };
    }
    handle.commitSha = swapped.commitSha;
    handle.epoch = envelope.subject.epoch;
    handle.expiresAt = null;
    handle.released = true;
    this.#handles.delete(handle.key);
    return { released: true, commitSha: swapped.commitSha, epoch: handle.epoch };
  }

  retain(handle) {
    this.#assertCurrent(handle);
    this.stopHeartbeat(handle);
    this.#handles.delete(handle.key);
    return { retained: true, commitSha: handle.commitSha, epoch: handle.epoch, expiresAt: handle.expiresAt };
  }
}
