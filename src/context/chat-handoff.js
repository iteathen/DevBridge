import { PolicyError, ProtocolError } from '../errors.js';
import {
  CHAT_HANDOFF_PROTOCOL,
  DEFAULT_HANDOFF_BYTES,
  createChatHandoffValueContract,
} from './chat-handoff/value-contract.js';
import { createChatHandoffRecordContract } from './chat-handoff/record-contract.js';
import { createChatHandoffPointerContract } from './chat-handoff/pointer-contract.js';
import { createChatHandoffRetentionPolicy } from './chat-handoff/retention-policy.js';
import { ChatHandoffStoreTransaction } from './chat-handoff/store-transaction.js';

const createProtocolError = (message) => new ProtocolError(message);
const valueContract = createChatHandoffValueContract({ createError: createProtocolError });
const recordContract = createChatHandoffRecordContract({
  createError: createProtocolError,
  normalizePayload: valueContract.normalize,
  digestPayload: valueContract.digest,
  normalizeDigest: valueContract.normalizeDigest,
  describePayload: valueContract.describe,
});
const pointerContract = createChatHandoffPointerContract({
  createError: createProtocolError,
  normalizeText: valueContract.normalizeText,
  normalizeDigest: valueContract.normalizeDigest,
  normalizeSequence: valueContract.normalizeSequence,
  normalizeIdentifier: valueContract.normalizeIdentifier,
  normalizeTimestamp: valueContract.normalizeTimestamp,
});

export { CHAT_HANDOFF_PROTOCOL };

export function canonicalJson(value) { return valueContract.canonicalJson(value); }
export function normalizeChatHandoff(input, options = {}) { return valueContract.normalize(input, options); }
export function chatHandoffDigest(input, options = {}) { return valueContract.digest(input, options); }
export function buildChatHandoff(input, options = {}) { return valueContract.build(input, options); }
export function buildChatResumeSeed(recordOrHandoff, digestOverride = null, options = {}) { return valueContract.seed(recordOrHandoff, digestOverride, options); }
export function parseChatResumeSeed(seed) { return valueContract.parseSeed(seed); }
export function reconcileChatResume(input) { return valueContract.reconcile(input); }

export class ChatHandoffStore {
  #transaction;

  constructor({ stateStore, maxBytes = DEFAULT_HANDOFF_BYTES, maxRetained = 8, now = () => Date.now() }) {
    if (!stateStore || typeof stateStore.get !== 'function' || typeof stateStore.set !== 'function' || typeof stateStore.entries !== 'function') {
      throw new TypeError('ChatHandoffStore requires a StateStore with get/set/entries');
    }
    if (!Number.isSafeInteger(maxRetained) || maxRetained < 2 || maxRetained > 64) throw new ProtocolError('chat handoff maxRetained must be between 2 and 64');
    valueContract.normalize({
      protocol: CHAT_HANDOFF_PROTOCOL,
      handoffId: 'validation',
      sequence: 1,
      repository: 'validation/repository',
      baselineSha: '0'.repeat(40),
      headSha: '0'.repeat(40),
      branch: null,
      issueNumber: null,
      prNumber: null,
      runId: null,
      phase: null,
      completedActionIds: [],
      nextActionId: null,
      decisions: [],
      blockers: [],
      evidenceRefs: [],
      governingDocs: [],
      previousHandoffDigest: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }, { maxBytes });

    const retention = createChatHandoffRetentionPolicy({ maxRetained });
    const channel = {
      read: (key) => stateStore.get(key),
      write: (key, value) => stateStore.set(key, value),
      list: (prefix) => stateStore.entries(prefix),
      remove: typeof stateStore.delete === 'function' ? (key) => stateStore.delete(key) : null,
    };
    this.#transaction = new ChatHandoffStoreTransaction({
      channel,
      maxBytes,
      now,
      ports: {
        normalizeSubject: valueContract.normalizeSubject,
        buildValue: valueContract.build,
        digestValue: valueContract.digest,
        describeValue: valueContract.describe,
        locate: pointerContract.locate,
        verifyRecord: recordContract.verify,
        verifyPointer: pointerContract.verify,
        createPlanned: recordContract.planned,
        createReady: recordContract.ready,
        createReference: pointerContract.reference,
        createPointer: pointerContract.next,
        recordOrder: recordContract.order,
        selectRemovals: retention.removals,
        seed: valueContract.seed,
        assertSubject: (record, subject, fallback) => {
          if (record.handoff.repository !== subject) {
            throw new ProtocolError(fallback
              ? 'fallback chat handoff repository does not match pointer repository'
              : 'chat handoff record repository does not match pointer repository');
          }
        },
        createPolicyError: (message) => new PolicyError(message),
        createProtocolError,
      },
    });
  }

  loadLatest(repositoryName, options = {}) { return this.#transaction.loadLatest(repositoryName, options); }
  checkpoint(input) { return this.#transaction.checkpoint(input); }
}
