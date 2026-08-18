import { createHash } from 'node:crypto';
import { PolicyError, ProtocolError } from '../errors.js';

export const CHAT_HANDOFF_PROTOCOL = 'patch-poller/chat-handoff-v1';
const STORE_PROTOCOL = 'patch-poller/chat-handoff-store-v1';
const POINTER_PROTOCOL = 'patch-poller/chat-handoff-pointer-v1';
const DEFAULT_MAX_BYTES = 32 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const BRANCH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const REFERENCE_PREFIXES = ['commit:', 'workflow:', 'issue:', 'pr:', 'run:', 'test:', 'doc:', 'repo:', 'github:'];

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError(`${name} must be an object`);
  return value;
}

function closedObject(value, allowed, name) {
  const object = plainObject(value, name);
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new ProtocolError(`${name}.${key} is not allowed`);
  return object;
}

function boundedString(value, name, max, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ProtocolError(`${name} must be a non-empty string <= ${max} characters`);
  if (/\u0000/u.test(value)) throw new ProtocolError(`${name} contains a NUL control character`);
  return value;
}

function safeId(value, name, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) throw new ProtocolError(`${name} must be a safe bounded identifier`);
  return value;
}

function sha256(value, name, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new ProtocolError(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function gitSha(value, name) {
  if (typeof value !== 'string' || !GIT_SHA_RE.test(value)) throw new ProtocolError(`${name} must be an exact lowercase 40-hex Git SHA`);
  return value;
}

function positiveInteger(value, name, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError(`${name} must be a positive safe integer`);
  return value;
}

function repository(value) {
  if (typeof value !== 'string' || !REPOSITORY_RE.test(value)) throw new ProtocolError('chat handoff repository must be owner/name');
  return value;
}

function branch(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !BRANCH_RE.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('.lock')) {
    throw new ProtocolError('chat handoff branch must be a safe Git branch name');
  }
  return value;
}

function isoTimestamp(value, name) {
  const text = boundedString(value, name, 40);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) throw new ProtocolError(`${name} must be a normalized ISO-8601 UTC timestamp`);
  return text;
}

function repoPath(value, name) {
  const text = boundedString(value, name, 300);
  if (text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/u.test(text)) throw new ProtocolError(`${name} must be repository-relative`);
  const parts = text.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..') || parts.some((part) => part.toLowerCase() === '.git')) {
    throw new ProtocolError(`${name} contains an unsafe path segment`);
  }
  if (parts.some((part) => !/^[A-Za-z0-9_.+-]+$/u.test(part))) throw new ProtocolError(`${name} contains unsupported path characters`);
  return text;
}

function reference(value, name) {
  const text = boundedString(value, name, 512);
  if (!REFERENCE_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    throw new ProtocolError(`${name} must use an approved durable-reference prefix`);
  }
  if (text.includes('\\') || /(?:^|\/)\.\.(?:\/|$)/u.test(text) || /^[A-Za-z]:[\\/]/u.test(text)) {
    throw new ProtocolError(`${name} must not contain a local filesystem path`);
  }
  return text;
}

function normalizedActionIds(value, name) {
  if (!Array.isArray(value) || value.length > 256) throw new ProtocolError(`${name} must be an array of at most 256 action IDs`);
  const ids = value.map((entry, index) => safeId(entry, `${name}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new ProtocolError(`${name} contains duplicate action IDs`);
  return ids.sort();
}

function normalizedBlockers(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) throw new ProtocolError('chat handoff blockers must contain at most 32 entries');
  return value.map((entry, index) => boundedString(entry, `chat handoff blockers[${index}]`, 2_000));
}

function normalizedDecisions(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) throw new ProtocolError('chat handoff decisions must contain at most 32 entries');
  const decisions = value.map((entry, index) => {
    const item = closedObject(entry, new Set(['id', 'digest', 'summary']), `chat handoff decisions[${index}]`);
    return {
      id: safeId(item.id, `chat handoff decisions[${index}].id`),
      digest: sha256(item.digest, `chat handoff decisions[${index}].digest`),
      summary: boundedString(item.summary, `chat handoff decisions[${index}].summary`, 1_000),
    };
  });
  if (new Set(decisions.map((item) => item.id)).size !== decisions.length) throw new ProtocolError('chat handoff decisions contain duplicate IDs');
  return decisions.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizedEvidence(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ProtocolError('chat handoff evidenceRefs must contain at most 64 entries');
  const entries = value.map((entry, index) => {
    const item = closedObject(entry, new Set(['id', 'kind', 'locator', 'sha256']), `chat handoff evidenceRefs[${index}]`);
    return {
      id: safeId(item.id, `chat handoff evidenceRefs[${index}].id`),
      kind: safeId(item.kind, `chat handoff evidenceRefs[${index}].kind`),
      locator: reference(item.locator, `chat handoff evidenceRefs[${index}].locator`),
      sha256: sha256(item.sha256, `chat handoff evidenceRefs[${index}].sha256`, { nullable: true }),
    };
  });
  if (new Set(entries.map((item) => item.id)).size !== entries.length) throw new ProtocolError('chat handoff evidenceRefs contain duplicate IDs');
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizedDocs(value, name = 'chat handoff governingDocs') {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) throw new ProtocolError(`${name} must contain at most 32 entries`);
  const docs = value.map((entry, index) => {
    const item = closedObject(entry, new Set(['path', 'sha256']), `${name}[${index}]`);
    return {
      path: repoPath(item.path, `${name}[${index}].path`),
      sha256: sha256(item.sha256, `${name}[${index}].sha256`),
    };
  });
  if (new Set(docs.map((item) => item.path)).size !== docs.length) throw new ProtocolError(`${name} contains duplicate paths`);
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function canonicalValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function normalizeChatHandoff(input, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4_096 || maxBytes > 256 * 1024) throw new ProtocolError('chat handoff maxBytes must be between 4096 and 262144');
  const value = closedObject(input, new Set([
    'protocol', 'handoffId', 'sequence', 'repository', 'baselineSha', 'headSha', 'branch',
    'issueNumber', 'prNumber', 'runId', 'phase', 'completedActionIds', 'nextActionId',
    'decisions', 'blockers', 'evidenceRefs', 'governingDocs', 'previousHandoffDigest', 'createdAt',
  ]), 'chat handoff');
  if (value.protocol !== CHAT_HANDOFF_PROTOCOL) throw new ProtocolError(`chat handoff protocol must be ${CHAT_HANDOFF_PROTOCOL}`);

  const normalized = {
    protocol: CHAT_HANDOFF_PROTOCOL,
    handoffId: safeId(value.handoffId, 'chat handoff handoffId'),
    sequence: positiveInteger(value.sequence, 'chat handoff sequence'),
    repository: repository(value.repository),
    baselineSha: gitSha(value.baselineSha, 'chat handoff baselineSha'),
    headSha: gitSha(value.headSha, 'chat handoff headSha'),
    branch: branch(value.branch ?? null),
    issueNumber: positiveInteger(value.issueNumber, 'chat handoff issueNumber', { nullable: true }),
    prNumber: positiveInteger(value.prNumber, 'chat handoff prNumber', { nullable: true }),
    runId: safeId(value.runId, 'chat handoff runId', { nullable: true }),
    phase: safeId(value.phase, 'chat handoff phase', { nullable: true }),
    completedActionIds: normalizedActionIds(value.completedActionIds ?? [], 'chat handoff completedActionIds'),
    nextActionId: safeId(value.nextActionId, 'chat handoff nextActionId', { nullable: true }),
    decisions: normalizedDecisions(value.decisions),
    blockers: normalizedBlockers(value.blockers),
    evidenceRefs: normalizedEvidence(value.evidenceRefs),
    governingDocs: normalizedDocs(value.governingDocs),
    previousHandoffDigest: sha256(value.previousHandoffDigest, 'chat handoff previousHandoffDigest', { nullable: true }),
    createdAt: isoTimestamp(value.createdAt, 'chat handoff createdAt'),
  };

  const bytes = Buffer.byteLength(canonicalJson(normalized), 'utf8');
  if (bytes > maxBytes) throw new ProtocolError(`chat handoff exceeds configured ${maxBytes}-byte ceiling`);
  return normalized;
}

export function chatHandoffDigest(input, options = {}) {
  const normalized = normalizeChatHandoff(input, options);
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

export function buildChatHandoff(input, { now = () => Date.now(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const value = {
    ...input,
    protocol: CHAT_HANDOFF_PROTOCOL,
    createdAt: input.createdAt ?? new Date(now()).toISOString(),
  };
  return normalizeChatHandoff(value, { maxBytes });
}

function repositoryStatePrefix(repositoryName) {
  const digest = createHash('sha256').update(repositoryName, 'utf8').digest('hex').slice(0, 24);
  return `chat-handoff.${digest}`;
}

function verifyStoreRecord(record, { expectedDigest = null, expectedState = null, maxBytes }) {
  const value = closedObject(record, new Set(['protocol', 'state', 'digest', 'handoff', 'createdAt', 'verifiedAt']), 'chat handoff store record');
  if (value.protocol !== STORE_PROTOCOL) throw new ProtocolError('chat handoff store record protocol is invalid');
  if (!['planned', 'ready'].includes(value.state)) throw new ProtocolError('chat handoff store record state is invalid');
  if (expectedState && value.state !== expectedState) throw new ProtocolError(`chat handoff store record is ${value.state}, expected ${expectedState}`);
  const digest = sha256(value.digest, 'chat handoff store record digest');
  if (expectedDigest && digest !== expectedDigest) throw new ProtocolError('chat handoff store record digest does not match expected digest');
  const handoff = normalizeChatHandoff(value.handoff, { maxBytes });
  if (chatHandoffDigest(handoff, { maxBytes }) !== digest) throw new ProtocolError('chat handoff store record payload digest mismatch');
  return { ...value, digest, handoff };
}

function verifyPointer(pointer) {
  if (pointer == null) return null;
  const value = closedObject(pointer, new Set(['protocol', 'current', 'previous', 'updatedAt']), 'chat handoff pointer');
  if (value.protocol !== POINTER_PROTOCOL) throw new ProtocolError('chat handoff pointer protocol is invalid');
  const normalizeRef = (ref, name) => {
    if (ref == null) return null;
    const item = closedObject(ref, new Set(['key', 'digest', 'sequence', 'handoffId']), name);
    return {
      key: boundedString(item.key, `${name}.key`, 300),
      digest: sha256(item.digest, `${name}.digest`),
      sequence: positiveInteger(item.sequence, `${name}.sequence`),
      handoffId: safeId(item.handoffId, `${name}.handoffId`),
    };
  };
  return {
    protocol: POINTER_PROTOCOL,
    current: normalizeRef(value.current, 'chat handoff pointer current'),
    previous: normalizeRef(value.previous, 'chat handoff pointer previous'),
    updatedAt: isoTimestamp(value.updatedAt, 'chat handoff pointer updatedAt'),
  };
}

export class ChatHandoffStore {
  #store;
  #maxBytes;
  #maxRetained;
  #now;

  constructor({ stateStore, maxBytes = DEFAULT_MAX_BYTES, maxRetained = 8, now = () => Date.now() }) {
    if (!stateStore || typeof stateStore.get !== 'function' || typeof stateStore.set !== 'function' || typeof stateStore.entries !== 'function') {
      throw new TypeError('ChatHandoffStore requires a StateStore with get/set/entries');
    }
    if (!Number.isSafeInteger(maxRetained) || maxRetained < 2 || maxRetained > 64) throw new ProtocolError('chat handoff maxRetained must be between 2 and 64');
    this.#store = stateStore;
    this.#maxBytes = maxBytes;
    this.#maxRetained = maxRetained;
    this.#now = now;
    normalizeChatHandoff({
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
    }, { maxBytes: this.#maxBytes });
  }

  #keys(repositoryName) {
    const prefix = repositoryStatePrefix(repositoryName);
    return { prefix, pointer: `${prefix}.latest`, records: `${prefix}.record.` };
  }

  async #loadRef(ref) {
    if (!ref) return null;
    const raw = await this.#store.get(ref.key);
    if (!raw) throw new ProtocolError(`chat handoff record ${ref.key} is missing`);
    return verifyStoreRecord(raw, { expectedDigest: ref.digest, expectedState: 'ready', maxBytes: this.#maxBytes });
  }

  async loadLatest(repositoryName, { allowFallback = true } = {}) {
    const repo = repository(repositoryName);
    const keys = this.#keys(repo);
    const pointer = verifyPointer(await this.#store.get(keys.pointer));
    if (!pointer?.current) return null;
    try {
      const record = await this.#loadRef(pointer.current);
      if (record.handoff.repository !== repo) throw new ProtocolError('chat handoff record repository does not match pointer repository');
      return { record, ref: pointer.current, recoveredFromPrevious: false, seed: buildChatResumeSeed(record) };
    } catch (error) {
      if (!allowFallback || !pointer.previous) throw error;
      const record = await this.#loadRef(pointer.previous);
      if (record.handoff.repository !== repo) throw new ProtocolError('fallback chat handoff repository does not match pointer repository');
      return { record, ref: pointer.previous, recoveredFromPrevious: true, recoveryError: { name: error.name, message: error.message }, seed: buildChatResumeSeed(record) };
    }
  }

  async checkpoint(input) {
    const handoff = buildChatHandoff(input, { now: this.#now, maxBytes: this.#maxBytes });
    const digest = chatHandoffDigest(handoff, { maxBytes: this.#maxBytes });
    const keys = this.#keys(handoff.repository);
    const pointer = verifyPointer(await this.#store.get(keys.pointer));
    if (pointer?.current?.digest === digest) {
      const record = await this.#loadRef(pointer.current);
      return { record, ref: pointer.current, previousDigest: pointer.previous?.digest ?? null, idempotent: true, seed: buildChatResumeSeed(record) };
    }
    if (pointer?.current && handoff.sequence <= pointer.current.sequence) {
      throw new PolicyError('chat handoff replacement sequence must advance beyond the current verified handoff');
    }
    if (handoff.previousHandoffDigest && pointer?.current?.digest !== handoff.previousHandoffDigest) {
      throw new PolicyError('chat handoff previousHandoffDigest does not match the current verified handoff');
    }

    const recordKey = `${keys.records}${handoff.sequence}.${digest.slice(0, 16)}`;
    const createdAt = new Date(this.#now()).toISOString();
    const planned = { protocol: STORE_PROTOCOL, state: 'planned', digest, handoff, createdAt, verifiedAt: null };
    await this.#store.set(recordKey, planned);
    verifyStoreRecord(await this.#store.get(recordKey), { expectedDigest: digest, expectedState: 'planned', maxBytes: this.#maxBytes });

    const ready = { ...planned, state: 'ready', verifiedAt: new Date(this.#now()).toISOString() };
    await this.#store.set(recordKey, ready);
    const verified = verifyStoreRecord(await this.#store.get(recordKey), { expectedDigest: digest, expectedState: 'ready', maxBytes: this.#maxBytes });

    const ref = { key: recordKey, digest, sequence: handoff.sequence, handoffId: handoff.handoffId };
    const nextPointer = {
      protocol: POINTER_PROTOCOL,
      current: ref,
      previous: pointer?.current ?? pointer?.previous ?? null,
      updatedAt: new Date(this.#now()).toISOString(),
    };
    await this.#store.set(keys.pointer, nextPointer);
    const observedPointer = verifyPointer(await this.#store.get(keys.pointer));
    if (observedPointer.current?.digest !== digest) throw new ProtocolError('chat handoff pointer verification failed');
    await this.#loadRef(observedPointer.current);
    await this.#prune(handoff.repository, observedPointer);
    return { record: verified, ref, previousDigest: nextPointer.previous?.digest ?? null, idempotent: false, seed: buildChatResumeSeed(verified) };
  }

  async #prune(repositoryName, pointer) {
    const keys = this.#keys(repositoryName);
    const entries = await this.#store.entries(keys.records);
    const keep = new Set([pointer.current?.key, pointer.previous?.key].filter(Boolean));
    const ranked = entries
      .map(([key, value]) => ({ key, sequence: value?.handoff?.sequence ?? 0 }))
      .sort((a, b) => b.sequence - a.sequence || a.key.localeCompare(b.key));
    for (const entry of ranked.slice(0, this.#maxRetained)) keep.add(entry.key);
    for (const entry of ranked) {
      if (!keep.has(entry.key) && typeof this.#store.delete === 'function') await this.#store.delete(entry.key);
    }
  }
}

export function buildChatResumeSeed(recordOrHandoff, digestOverride = null) {
  const handoff = recordOrHandoff?.handoff ?? recordOrHandoff;
  const normalized = normalizeChatHandoff(handoff);
  const digest = digestOverride ?? recordOrHandoff?.digest ?? chatHandoffDigest(normalized);
  sha256(digest, 'chat resume seed digest');
  return `PATCH-POLLER-RESUME v1 repo=${normalized.repository} handoff=${normalized.handoffId} sha256=${digest}`;
}

export function parseChatResumeSeed(seed) {
  const text = boundedString(seed, 'chat resume seed', 512);
  const match = text.match(/^PATCH-POLLER-RESUME v1 repo=([^ ]+) handoff=([^ ]+) sha256=([0-9a-f]{64})$/u);
  if (!match) throw new ProtocolError('chat resume seed is malformed');
  return { protocol: 'patch-poller/chat-resume-seed-v1', repository: repository(match[1]), handoffId: safeId(match[2], 'chat resume seed handoffId'), digest: sha256(match[3], 'chat resume seed digest') };
}

function normalizeObservedResume(input) {
  const value = closedObject(input, new Set(['repository', 'baselineSha', 'headSha', 'issueNumber', 'prNumber', 'runId', 'completedActionIds', 'governingDocs']), 'chat resume observation');
  return {
    repository: repository(value.repository),
    baselineSha: gitSha(value.baselineSha, 'chat resume observation baselineSha'),
    headSha: gitSha(value.headSha, 'chat resume observation headSha'),
    issueNumber: positiveInteger(value.issueNumber, 'chat resume observation issueNumber', { nullable: true }),
    prNumber: positiveInteger(value.prNumber, 'chat resume observation prNumber', { nullable: true }),
    runId: safeId(value.runId, 'chat resume observation runId', { nullable: true }),
    completedActionIds: normalizedActionIds(value.completedActionIds ?? [], 'chat resume observation completedActionIds'),
    governingDocs: normalizedDocs(value.governingDocs, 'chat resume observation governingDocs'),
  };
}

export function reconcileChatResume({ handoff, observed, acknowledgedRereadPaths = [] }) {
  const expected = normalizeChatHandoff(handoff);
  const actual = normalizeObservedResume(observed);
  if (!Array.isArray(acknowledgedRereadPaths) || acknowledgedRereadPaths.length > 32) throw new ProtocolError('acknowledgedRereadPaths must contain at most 32 repository paths');
  const acknowledged = new Set(acknowledgedRereadPaths.map((entry, index) => repoPath(entry, `acknowledgedRereadPaths[${index}]`)));
  const mismatches = [];
  const compare = (field, left, right) => { if (!Object.is(left, right)) mismatches.push({ field, expected: left, observed: right }); };
  compare('repository', expected.repository, actual.repository);
  compare('baselineSha', expected.baselineSha, actual.baselineSha);
  compare('headSha', expected.headSha, actual.headSha);
  if (expected.issueNumber != null) compare('issueNumber', expected.issueNumber, actual.issueNumber);
  if (expected.prNumber != null) compare('prNumber', expected.prNumber, actual.prNumber);
  if (expected.runId != null) compare('runId', expected.runId, actual.runId);

  const actualDocs = new Map(actual.governingDocs.map((entry) => [entry.path, entry.sha256]));
  const mustReread = expected.governingDocs
    .filter((entry) => actualDocs.get(entry.path) !== entry.sha256)
    .map((entry) => entry.path);
  const unacknowledgedRereads = mustReread.filter((entry) => !acknowledged.has(entry));
  const completed = new Set([...expected.completedActionIds, ...actual.completedActionIds]);

  if (mismatches.length) return { status: 'stale', mismatches, mustReread, nextActionId: null, pendingNextActionId: expected.nextActionId };
  if (unacknowledgedRereads.length) return { status: 'reread-required', mismatches: [], mustReread: unacknowledgedRereads, nextActionId: null, pendingNextActionId: expected.nextActionId };
  if (expected.nextActionId && completed.has(expected.nextActionId)) {
    return { status: 'checkpoint-required', mismatches: [], mustReread: [], nextActionId: null, pendingNextActionId: null, skippedCompletedActionId: expected.nextActionId };
  }
  return { status: 'ready', mismatches: [], mustReread: [], nextActionId: expected.nextActionId, pendingNextActionId: expected.nextActionId };
}
