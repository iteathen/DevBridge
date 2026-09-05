import { createHash } from 'node:crypto';

export const CHAT_HANDOFF_PROTOCOL = 'devbridge/chat-handoff-v1';
export const DEFAULT_HANDOFF_BYTES = 32 * 1024;
export const MAX_HANDOFF_BYTES = 256 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/u;
const GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const BRANCH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const REFERENCE_PREFIXES = ['commit:', 'workflow:', 'issue:', 'pr:', 'run:', 'test:', 'doc:', 'repo:', 'github:'];

export function createChatHandoffValueContract({ createError }) {
  if (typeof createError !== 'function') throw new TypeError('value contract requires an error factory');
  const fail = (message) => { throw createError(message); };

  function plainObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
    return value;
  }

  function closedObject(value, allowed, name) {
    const object = plainObject(value, name);
    for (const key of Object.keys(object)) if (!allowed.has(key)) fail(`${name}.${key} is not allowed`);
    return object;
  }

  function boundedString(value, name, max, { nullable = false } = {}) {
    if (value == null && nullable) return null;
    if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`${name} must be a non-empty string <= ${max} characters`);
    if (/\u0000/u.test(value)) fail(`${name} contains a NUL control character`);
    return value;
  }

  function safeId(value, name, { nullable = false } = {}) {
    if (value == null && nullable) return null;
    if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) fail(`${name} must be a safe bounded identifier`);
    return value;
  }

  function sha256(value, name, { nullable = false } = {}) {
    if (value == null && nullable) return null;
    if (typeof value !== 'string' || !SHA256_RE.test(value)) fail(`${name} must be a lowercase SHA-256 digest`);
    return value;
  }

  function gitSha(value, name) {
    if (typeof value !== 'string' || !GIT_SHA_RE.test(value)) fail(`${name} must be an exact lowercase 40-hex Git SHA`);
    return value;
  }

  function positiveInteger(value, name, { nullable = false } = {}) {
    if (value == null && nullable) return null;
    if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive safe integer`);
    return value;
  }

  function repository(value) {
    if (typeof value !== 'string' || !REPOSITORY_RE.test(value)) fail('chat handoff repository must be owner/name');
    return value;
  }

  function branch(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || !BRANCH_RE.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('.lock')) {
      fail('chat handoff branch must be a safe Git branch name');
    }
    return value;
  }

  function isoTimestamp(value, name) {
    const text = boundedString(value, name, 40);
    const millis = Date.parse(text);
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) fail(`${name} must be a normalized ISO-8601 UTC timestamp`);
    return text;
  }

  function repoPath(value, name) {
    const text = boundedString(value, name, 300);
    if (text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/u.test(text)) fail(`${name} must be repository-relative`);
    const parts = text.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..') || parts.some((part) => part.toLowerCase() === '.git')) fail(`${name} contains an unsafe path segment`);
    if (parts.some((part) => !/^[A-Za-z0-9_.+-]+$/u.test(part))) fail(`${name} contains unsupported path characters`);
    return text;
  }

  function reference(value, name) {
    const text = boundedString(value, name, 512);
    if (!REFERENCE_PREFIXES.some((prefix) => text.startsWith(prefix))) fail(`${name} must use an approved durable-reference prefix`);
    if (text.includes('\\') || /(?:^|\/)\.\.(?:\/|$)/u.test(text) || /^[A-Za-z]:[\\/]/u.test(text)) fail(`${name} must not contain a local filesystem path`);
    return text;
  }

  function normalizedActionIds(value, name) {
    if (!Array.isArray(value) || value.length > 256) fail(`${name} must be an array of at most 256 action IDs`);
    const ids = value.map((entry, index) => safeId(entry, `${name}[${index}]`));
    if (new Set(ids).size !== ids.length) fail(`${name} contains duplicate action IDs`);
    return ids.sort();
  }

  function normalizedBlockers(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 32) fail('chat handoff blockers must contain at most 32 entries');
    return value.map((entry, index) => boundedString(entry, `chat handoff blockers[${index}]`, 2_000));
  }

  function normalizedDecisions(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 32) fail('chat handoff decisions must contain at most 32 entries');
    const decisions = value.map((entry, index) => {
      const item = closedObject(entry, new Set(['id', 'digest', 'summary']), `chat handoff decisions[${index}]`);
      return {
        id: safeId(item.id, `chat handoff decisions[${index}].id`),
        digest: sha256(item.digest, `chat handoff decisions[${index}].digest`),
        summary: boundedString(item.summary, `chat handoff decisions[${index}].summary`, 1_000),
      };
    });
    if (new Set(decisions.map((item) => item.id)).size !== decisions.length) fail('chat handoff decisions contain duplicate IDs');
    return decisions.sort((a, b) => a.id.localeCompare(b.id));
  }

  function normalizedEvidence(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 64) fail('chat handoff evidenceRefs must contain at most 64 entries');
    const entries = value.map((entry, index) => {
      const item = closedObject(entry, new Set(['id', 'kind', 'locator', 'sha256']), `chat handoff evidenceRefs[${index}]`);
      return {
        id: safeId(item.id, `chat handoff evidenceRefs[${index}].id`),
        kind: safeId(item.kind, `chat handoff evidenceRefs[${index}].kind`),
        locator: reference(item.locator, `chat handoff evidenceRefs[${index}].locator`),
        sha256: sha256(item.sha256, `chat handoff evidenceRefs[${index}].sha256`, { nullable: true }),
      };
    });
    if (new Set(entries.map((item) => item.id)).size !== entries.length) fail('chat handoff evidenceRefs contain duplicate IDs');
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  function normalizedDocs(value, name = 'chat handoff governingDocs') {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 32) fail(`${name} must contain at most 32 entries`);
    const docs = value.map((entry, index) => {
      const item = closedObject(entry, new Set(['path', 'sha256']), `${name}[${index}]`);
      return { path: repoPath(item.path, `${name}[${index}].path`), sha256: sha256(item.sha256, `${name}[${index}].sha256`) };
    });
    if (new Set(docs.map((item) => item.path)).size !== docs.length) fail(`${name} contains duplicate paths`);
    return docs.sort((a, b) => a.path.localeCompare(b.path));
  }

  function canonicalValue(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalValue);
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
    return result;
  }

  function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }

  function normalize(input, { maxBytes = DEFAULT_HANDOFF_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4_096 || maxBytes > MAX_HANDOFF_BYTES) fail('chat handoff maxBytes must be between 4096 and 262144');
    const value = closedObject(input, new Set([
      'protocol', 'handoffId', 'sequence', 'repository', 'baselineSha', 'headSha', 'branch',
      'issueNumber', 'prNumber', 'runId', 'phase', 'completedActionIds', 'nextActionId',
      'decisions', 'blockers', 'evidenceRefs', 'governingDocs', 'previousHandoffDigest', 'createdAt',
    ]), 'chat handoff');
    if (value.protocol !== CHAT_HANDOFF_PROTOCOL) fail(`chat handoff protocol must be ${CHAT_HANDOFF_PROTOCOL}`);
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
    if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > maxBytes) fail(`chat handoff exceeds configured ${maxBytes}-byte ceiling`);
    return normalized;
  }

  function digest(input, options = {}) {
    const normalized = normalize(input, options);
    return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
  }

  function build(input, { now = () => Date.now(), maxBytes = DEFAULT_HANDOFF_BYTES } = {}) {
    return normalize({ ...input, protocol: CHAT_HANDOFF_PROTOCOL, createdAt: input.createdAt ?? new Date(now()).toISOString() }, { maxBytes });
  }

  function seed(recordOrHandoff, digestOverride = null, { maxBytes = MAX_HANDOFF_BYTES } = {}) {
    const handoff = recordOrHandoff?.handoff ?? recordOrHandoff;
    const normalized = normalize(handoff, { maxBytes });
    const identity = digestOverride ?? recordOrHandoff?.digest ?? digest(normalized, { maxBytes });
    sha256(identity, 'chat resume seed digest');
    return `DEVBRIDGE-RESUME v1 repo=${normalized.repository} handoff=${normalized.handoffId} sha256=${identity}`;
  }

  function parseSeed(seedValue) {
    const text = boundedString(seedValue, 'chat resume seed', 512);
    const match = text.match(/^DEVBRIDGE-RESUME v1 repo=([^ ]+) handoff=([^ ]+) sha256=([0-9a-f]{64})$/u);
    if (!match) fail('chat resume seed is malformed');
    return { protocol: 'devbridge/chat-resume-seed-v1', repository: repository(match[1]), handoffId: safeId(match[2], 'chat resume seed handoffId'), digest: sha256(match[3], 'chat resume seed digest') };
  }

  function normalizeObservation(input) {
    const value = closedObject(input, new Set(['repository', 'baselineSha', 'headSha', 'issueNumber', 'prNumber', 'runId', 'completedActionIds', 'governingDocs']), 'chat resume observation');
    return {
      repository: repository(value.repository), baselineSha: gitSha(value.baselineSha, 'chat resume observation baselineSha'), headSha: gitSha(value.headSha, 'chat resume observation headSha'),
      issueNumber: positiveInteger(value.issueNumber, 'chat resume observation issueNumber', { nullable: true }),
      prNumber: positiveInteger(value.prNumber, 'chat resume observation prNumber', { nullable: true }),
      runId: safeId(value.runId, 'chat resume observation runId', { nullable: true }),
      completedActionIds: normalizedActionIds(value.completedActionIds ?? [], 'chat resume observation completedActionIds'),
      governingDocs: normalizedDocs(value.governingDocs, 'chat resume observation governingDocs'),
    };
  }

  function reconcile({ handoff, observed, acknowledgedRereadPaths = [] }) {
    const expected = normalize(handoff, { maxBytes: MAX_HANDOFF_BYTES });
    const actual = normalizeObservation(observed);
    if (!Array.isArray(acknowledgedRereadPaths) || acknowledgedRereadPaths.length > 32) fail('acknowledgedRereadPaths must contain at most 32 repository paths');
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
    const mustReread = expected.governingDocs.filter((entry) => actualDocs.get(entry.path) !== entry.sha256).map((entry) => entry.path);
    const unacknowledgedRereads = mustReread.filter((entry) => !acknowledged.has(entry));
    const completed = new Set([...expected.completedActionIds, ...actual.completedActionIds]);
    if (mismatches.length) return { status: 'stale', mismatches, mustReread, nextActionId: null, pendingNextActionId: expected.nextActionId };
    if (unacknowledgedRereads.length) return { status: 'reread-required', mismatches: [], mustReread: unacknowledgedRereads, nextActionId: null, pendingNextActionId: expected.nextActionId };
    if (expected.nextActionId && completed.has(expected.nextActionId)) return { status: 'checkpoint-required', mismatches: [], mustReread: [], nextActionId: null, pendingNextActionId: null, skippedCompletedActionId: expected.nextActionId };
    return { status: 'ready', mismatches: [], mustReread: [], nextActionId: expected.nextActionId, pendingNextActionId: expected.nextActionId };
  }

  function describe(value) {
    return { subject: value?.repository, order: value?.sequence, previousIdentity: value?.previousHandoffDigest, identity: value?.handoffId };
  }

  return Object.freeze({
    protocol: CHAT_HANDOFF_PROTOCOL, canonicalJson, normalize, digest, build, seed, parseSeed, reconcile, describe,
    normalizeSubject: repository, normalizeText: boundedString, normalizeDigest: sha256,
    normalizeSequence: positiveInteger, normalizeIdentifier: safeId, normalizeTimestamp: isoTimestamp,
  });
}
