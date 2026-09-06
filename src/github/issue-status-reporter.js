import { randomBytes } from 'node:crypto';
import { fitContextCapsule } from '../context/context-capsule.js';
import { ProtocolError, TaskLeaseLostError } from '../errors.js';
import { guardActiveTaskLease } from '../run/lease-execution-context.js';
import { observeStatusComment } from './status-comment-observation.js';
import { renderStatusDiagnostics, sanitizeStatusText } from './status-diagnostics.js';

const SERIAL = new WeakMap();
const MAX_CREATE_ATTEMPTS = 3;
const CREATION_MARKER_RESERVE = 128;

function serialize(store, key, action) {
  let active = SERIAL.get(store);
  if (!active) { active = new Map(); SERIAL.set(store, active); }
  const work = (active.get(key) ?? Promise.resolve()).then(action, action);
  const tail = work.then(() => undefined, () => undefined);
  active.set(key, tail);
  void tail.then(() => { if (active.get(key) === tail) active.delete(key); });
  return work;
}

async function taskLeaseAllowsEffect() {
  try { await guardActiveTaskLease(); return true; }
  catch (error) { if (error instanceof TaskLeaseLostError) return false; throw error; }
}

function subjectFor({ issueNumber, runId, revision }) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1
      || typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/u.test(runId)
      || typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)) throw new ProtocolError('status subject is invalid');
  return { issueNumber, runId, revision };
}

function assertSubject(record, subject) {
  if (record.subject && Object.keys(subject).some(key => record.subject[key] !== subject[key])) throw new ProtocolError('status subject does not match durable delivery intent');
}

function renderBody({ runId, revision, stage, summary, capsule, sequence }) {
  return [
    `<!-- devbridge-status run=${runId} revision=${revision} sequence=${sequence} -->`,
    `## DevBridge — ${stage}`, '', String(summary).split(/\r?\n/u).map(line => `    ${line}`).join('\n'), '',
    '```devbridge-context', JSON.stringify(capsule, null, 2), '```',
  ].join('\n');
}

export class IssueStatusReporter {
  #client;
  #stateStore;
  #queueRepository;
  #repositoryPath;
  #progressIntervalMs;
  #maxCommentBytes;
  #secrets;
  #inventoryRefProvider;
  #now;

  constructor({ client, stateStore, queueRepository, progressIntervalMs = 300_000,
    maxCommentBytes = 48_000, secretValues = [], inventoryRefProvider = null, now = () => Date.now() }) {
    if (!client || typeof client.request !== 'function' || !stateStore || typeof stateStore.get !== 'function' || typeof stateStore.set !== 'function') throw new TypeError('status reporter requires its client and state store');
    if (typeof queueRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(queueRepository)) throw new ProtocolError('status queue repository is invalid');
    if (!Number.isSafeInteger(maxCommentBytes) || maxCommentBytes < 4096) throw new ProtocolError('status comment budget is invalid');
    if (!Number.isSafeInteger(progressIntervalMs) || progressIntervalMs < 1) throw new ProtocolError('status interval is invalid');
    this.#client = client;
    this.#stateStore = stateStore;
    this.#queueRepository = queueRepository;
    this.#repositoryPath = `/repos/${queueRepository.split('/').map(encodeURIComponent).join('/')}`;
    this.#progressIntervalMs = progressIntervalMs;
    this.#maxCommentBytes = Math.min(maxCommentBytes, 60_000);
    this.#secrets = secretValues;
    this.#inventoryRefProvider = typeof inventoryRefProvider === 'function' ? inventoryRefProvider : null;
    this.#now = now;
  }

  #key(subject) { return `status.${this.#queueRepository}#${subject.issueNumber}.${subject.runId}`; }

  #body(input, sequence) {
    input = { ...input, summary: sanitizeStatusText(input.summary, this.#secrets) };
    const reference = this.#inventoryRefProvider?.() ?? null;
    const capsule = reference ? { ...input.capsule, toolInventory: reference } : input.capsule;
    const diagnostics = renderStatusDiagnostics(input.diagnostics, this.#secrets, Math.min(20_000, Math.floor(this.#maxCommentBytes / 2)));
    const limit = this.#maxCommentBytes - CREATION_MARKER_RESERVE - Buffer.byteLength(diagnostics, 'utf8') - 2;
    let fitted = fitContextCapsule(capsule, Math.max(2048, limit - 4096));
    let body = sanitizeStatusText(renderBody({ ...input, capsule: fitted, sequence }), this.#secrets);
    if (Buffer.byteLength(body, 'utf8') > limit) {
      fitted = fitContextCapsule(fitted, Math.max(2048, limit - 8192));
      body = sanitizeStatusText(renderBody({ ...input, summary: String(input.summary).slice(0, 2000), capsule: fitted, sequence }), this.#secrets);
    }
    if (Buffer.byteLength(body, 'utf8') > limit) {
      // Oversized context cannot suppress a terminal diagnostic. Keep exact
      // task identity and explicitly disclose this final compaction.
      body = sanitizeStatusText(renderBody({ ...input, summary: String(input.summary).slice(0, 200), sequence,
        capsule: { protocol: 'devbridge/context-v1', task: subjectFor(input), compacted: true,
          omissions: ['Context exceeded the status comment budget.'] },
      }), this.#secrets);
    }
    if (Buffer.byteLength(body, 'utf8') > limit) throw new RangeError('status report exceeds configured GitHub comment budget after compaction');
    return diagnostics ? `${body}\n\n${diagnostics}` : body;
  }

  publish(input) {
    const subject = subjectFor(input);
    if (typeof input.stage !== 'string' || !/^[A-Z][A-Z_ -]{0,63}$/u.test(input.stage)) throw new ProtocolError('status stage is invalid');
    const key = this.#key(subject);
    return serialize(this.#stateStore, key, async () => {
      const record = (await this.#stateStore.get(key)) ?? {};
      assertSubject(record, subject);
      if (!await taskLeaseAllowsEffect()) return { published: false, commentId: record.commentId ?? null, reason: 'lease-lost' };
      if (record.terminal || (record.pending?.terminal && !input.terminal)) return this.#deliver(key, record);
      if (!input.terminal && !input.force && record.publishedAt && this.#now() - record.publishedAt < this.#progressIntervalMs && record.stage === input.stage) {
        return record.pending ? this.#deliver(key, record) : { published: false, commentId: record.commentId ?? null };
      }
      const sequence = Math.max(record.sequence ?? 0, record.pending?.sequence ?? 0) + 1;
      record.subject = subject;
      record.pending = { body: this.#body(input, sequence), stage: input.stage, sequence, terminal: input.terminal === true };
      record.delivery = { ...record.delivery, state: 'pending', reason: 'projection-persisted', observedAt: this.#now() };
      // Persist desired bytes before authentication/network access. Keep the
      // uncertain earlier creation separately when a terminal report arrives.
      await this.#stateStore.set(key, record);
      return this.#deliver(key, record);
    });
  }

  async pending() {
    const entries = await this.#stateStore.entries(`status.${this.#queueRepository}#`);
    return entries.filter(([, record]) => record?.pending)
      .sort((a, b) => (a[1].delivery?.observedAt ?? 0) - (b[1].delivery?.observedAt ?? 0))
      .map(([key, record]) => {
      const subject = subjectFor(record.subject);
      if (this.#key(subject) !== key) throw new ProtocolError('status delivery key does not match subject');
      return subject;
    });
  }

  reconcile(input) {
    const subject = subjectFor(input);
    const key = this.#key(subject);
    return serialize(this.#stateStore, key, async () => {
      const record = (await this.#stateStore.get(key)) ?? {};
      assertSubject(record, subject);
      return this.#deliver(key, record);
    });
  }

  async #defer(key, record, reason) {
    record.delivery = { ...record.delivery, state: 'pending', reason, observedAt: this.#now() };
    await this.#stateStore.set(key, record);
    return { published: false, commentId: record.commentId ?? null, reason };
  }

  async #confirm(key, record, projection, commentId) {
    if (!Number.isSafeInteger(commentId) || commentId < 1) throw new ProtocolError('GitHub status publication did not return a comment ID');
    const leaseCurrent = await taskLeaseAllowsEffect();
    record.commentId = commentId;
    record.sequence = projection.sequence;
    record.stage = projection.stage;
    record.terminal = projection.terminal;
    record.publishedAt = this.#now();
    record.creation = null;
    if (record.pending?.sequence === projection.sequence) record.pending = null;
    record.delivery = { state: record.pending ? 'pending' : 'reported', reason: 'comment-confirmed', observedAt: this.#now() };
    await this.#stateStore.set(key, record);
    return { published: true, commentId, sequence: projection.sequence, ...(leaseCurrent ? {} : { leaseLost: true }) };
  }

  async #deliver(key, record) {
    if (!record.pending) return { published: false, commentId: record.commentId ?? null, reason: 'already-reported' };
    if (!await taskLeaseAllowsEffect()) return { published: false, commentId: record.commentId ?? null, reason: 'lease-lost' };
    if (Number.isFinite(record.delivery?.retryAt) && this.#now() < record.delivery.retryAt) return this.#defer(key, record, 'server-pacing');
    try {
      if (!record.commentId) {
        if (!record.creation) {
          const actor = await this.#client.request('POST', '/graphql', {
            body: { query: 'query DevBridgeStatusPublisher { viewer { databaseId } }' },
            mutation: false, critical: record.pending.terminal,
          });
          const actorId = actor.data?.errors?.length ? null : actor.data?.data?.viewer?.databaseId;
          if (!Number.isSafeInteger(actorId) || actorId < 1) throw new ProtocolError('authenticated status publisher identity is unavailable');
          const id = randomBytes(32).toString('hex');
          record.creation = { id, actorId: String(actorId), projection: record.pending,
            body: `${record.pending.body}\n<!-- devbridge-status-effect ${id} -->`, attempts: 0, attemptedAt: null };
          await this.#stateStore.set(key, record);
        }
        const creation = record.creation;
        if (creation.attempts > 0) {
          const observed = await observeStatusComment({ client: this.#client, repositoryPath: this.#repositoryPath,
            issueNumber: record.subject.issueNumber, creation, critical: record.pending.terminal });
          if (observed.commentId) {
            const confirmed = await this.#confirm(key, record, creation.projection, observed.commentId);
            if (!record.pending || confirmed.leaseLost) return confirmed;
          } else {
            if (!observed.complete || observed.reason !== 'creation-not-observed') return this.#defer(key, record, observed.reason);
            if (creation.attempts >= MAX_CREATE_ATTEMPTS) return this.#defer(key, record, 'creation-attempts-exhausted');
            if (this.#now() - creation.attemptedAt < this.#progressIntervalMs) return this.#defer(key, record, 'creation-observation-pending');
          }
        }
        if (!record.commentId) {
          if (creation.attempts > 0) {
            const actor = await this.#client.request('POST', '/graphql', {
              body: { query: 'query DevBridgeStatusPublisher { viewer { databaseId } }' },
              mutation: false, critical: record.pending.terminal,
            });
            if (actor.data?.errors?.length || String(actor.data?.data?.viewer?.databaseId) !== creation.actorId) {
              return this.#defer(key, record, 'publisher-identity-changed');
            }
          }
          if (!await taskLeaseAllowsEffect()) return this.#defer(key, record, 'lease-lost');
          creation.attempts += 1;
          creation.attemptedAt = this.#now();
          await this.#stateStore.set(key, record);
          const response = await this.#client.request('POST', `${this.#repositoryPath}/issues/${record.subject.issueNumber}/comments`, { body: { body: creation.body }, critical: record.pending.terminal });
          const confirmed = await this.#confirm(key, record, creation.projection, response.data?.id);
          if (!record.pending || confirmed.leaseLost) return confirmed;
        }
      }
      if (!await taskLeaseAllowsEffect()) return this.#defer(key, record, 'lease-lost');
      const projection = record.pending;
      const response = await this.#client.request('PATCH', `${this.#repositoryPath}/issues/comments/${record.commentId}`, { body: { body: projection.body }, critical: projection.terminal });
      if (response.data?.id !== record.commentId) throw new ProtocolError('GitHub status update returned a different comment ID');
      return await this.#confirm(key, record, projection, record.commentId);
    } catch (error) {
      // Delivery exceptions never replace the original operation result.
      record.delivery = { state: 'pending', reason: 'delivery-unavailable', observedAt: this.#now(), retryAt: error?.retryAt ?? null };
      await this.#stateStore.set(key, record);
      throw error;
    }
  }
}
