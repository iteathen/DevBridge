import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatHandoffStore } from '../src/context/chat-handoff.js';
import { ProtocolError } from '../src/errors.js';
import { createChatHandoffValueContract } from '../src/context/chat-handoff/value-contract.js';
import { createChatHandoffRecordContract } from '../src/context/chat-handoff/record-contract.js';
import { createChatHandoffPointerContract } from '../src/context/chat-handoff/pointer-contract.js';
import { createChatHandoffRetentionPolicy } from '../src/context/chat-handoff/retention-policy.js';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const parentPath = fileURLToPath(new URL('../src/context/chat-handoff.js', import.meta.url));
const nestedRoot = fileURLToPath(new URL('../src/context/chat-handoff/', import.meta.url));
const nestedFiles = ['value-contract.js', 'record-contract.js', 'pointer-contract.js', 'retention-policy.js', 'store-transaction.js'];
const createError = (message) => new ProtocolError(message);

function fixture(overrides = {}) {
  return {
    protocol: 'devbridge/chat-handoff-v1',
    handoffId: 'pp014-fixture-1',
    sequence: 1,
    repository: 'iteathen/DevBridge',
    baselineSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'sol/pp-014-context-rollover',
    issueNumber: 20,
    prNumber: null,
    runId: 'pp-20-fixture',
    phase: 'implementing',
    completedActionIds: ['read-specs', 'create-branch'],
    nextActionId: 'implement-core',
    decisions: [{ id: 'architecture', digest: '3'.repeat(64), summary: 'Use DB-005 plus DB-009 rather than a second effect journal.' }],
    blockers: [],
    evidenceRefs: [{ id: 'baseline', kind: 'commit', locator: `commit:${'a'.repeat(40)}`, sha256: null }],
    governingDocs: [
      { path: 'AGENTS.md', sha256: '1'.repeat(64) },
      { path: 'specs/DB-005-context-handoff.md', sha256: '2'.repeat(64) },
    ],
    previousHandoffDigest: null,
    createdAt: '2026-08-18T18:00:00.000Z',
    ...overrides,
  };
}

function contracts() {
  const value = createChatHandoffValueContract({ createError });
  const record = createChatHandoffRecordContract({
    createError,
    normalizePayload: value.normalize,
    digestPayload: value.digest,
    normalizeDigest: value.normalizeDigest,
    describePayload: value.describe,
  });
  const pointer = createChatHandoffPointerContract({
    createError,
    normalizeText: value.normalizeText,
    normalizeDigest: value.normalizeDigest,
    normalizeSequence: value.normalizeSequence,
    normalizeIdentifier: value.normalizeIdentifier,
    normalizeTimestamp: value.normalizeTimestamp,
  });
  return { value, record, pointer };
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(location);
    return /\.(?:m?js)$/u.test(entry.name) ? [location] : [];
  }));
  return nested.flat();
}

test('immutable value owner preserves the established canonical bytes and digest', () => {
  const { value } = contracts();
  const normalized = value.normalize(fixture());
  assert.deepEqual(normalized.completedActionIds, ['create-branch', 'read-specs']);
  assert.equal(value.digest(normalized), '33e360374592f4a01c7ead2d1137319837456bba6c3582d7d3fa6662fa9134ab');
  assert.equal(Buffer.byteLength(value.canonicalJson(normalized), 'utf8'), 1_055);
  assert.throws(() => value.normalize({ ...fixture(), executable: 'foreign' }), ProtocolError);
});

test('record and pointer owners validate their own envelopes without persistence authority', () => {
  const { value, record, pointer } = contracts();
  const handoff = value.normalize(fixture());
  const digest = value.digest(handoff);
  const planned = record.planned({ digest, handoff, createdAt: handoff.createdAt });
  assert.equal(record.verify(planned, { expectedDigest: digest, expectedState: 'planned', maxBytes: 32 * 1024 }).state, 'planned');
  assert.throws(() => record.verify({ ...planned, digest: 'f'.repeat(64) }, { maxBytes: 32 * 1024 }), /payload digest mismatch/u);

  const location = pointer.locate(handoff.repository);
  const ref = pointer.reference({ key: `${location.records}1.${digest.slice(0, 16)}`, digest, sequence: 1, handoffId: handoff.handoffId });
  const current = pointer.next({ current: ref, previous: null, updatedAt: handoff.createdAt });
  assert.deepEqual(pointer.verify(current), current);
  assert.throws(() => pointer.verify({ ...current, current: { ...ref, executable: 'foreign' } }), /not allowed/u);
});

test('retention owner ranks neutral summaries while protecting explicit identities', () => {
  const retention = createChatHandoffRetentionPolicy({ maxRetained: 2 });
  assert.deepEqual(retention.removals([
    { key: 'old-protected', order: 1 },
    { key: 'newest', order: 5 },
    { key: 'second', order: 4 },
    { key: 'third', order: 3 },
  ], ['old-protected']), ['third']);
});

test('parent preserves planned-ready-pointer readback ordering through neutral persistence ports', async () => {
  const values = new Map();
  const events = [];
  const stateStore = {
    async get(key) { events.push(['read', key, values.get(key)?.state ?? null]); return structuredClone(values.get(key)); },
    async set(key, value) { events.push(['write', key, value?.state ?? value?.protocol]); values.set(key, structuredClone(value)); },
    async entries(prefix) { events.push(['list', prefix]); return [...values.entries()].filter(([key]) => key.startsWith(prefix)); },
    async delete(key) { events.push(['remove', key]); values.delete(key); },
  };
  const store = new ChatHandoffStore({ stateStore, now: () => Date.parse('2026-08-18T18:00:00.000Z') });
  const saved = await store.checkpoint(fixture());
  assert.equal(saved.record.digest, '33e360374592f4a01c7ead2d1137319837456bba6c3582d7d3fa6662fa9134ab');
  assert.deepEqual(events.map(([action, key, state]) => [action, key.includes('.record.') ? 'record' : key.endsWith('.latest') ? 'pointer' : key, state]), [
    ['read', 'pointer', null],
    ['write', 'record', 'planned'],
    ['read', 'record', 'planned'],
    ['write', 'record', 'ready'],
    ['read', 'record', 'ready'],
    ['write', 'pointer', 'devbridge/chat-handoff-pointer-v1'],
    ['read', 'pointer', null],
    ['read', 'record', 'ready'],
    ['list', 'record', undefined],
  ]);
});

test('nested owners are sibling-independent and only the parent composes them', async () => {
  for (const file of nestedFiles) {
    const text = await readFile(path.join(nestedRoot, file), 'utf8');
    assert.doesNotMatch(text, /from ['"]\.\.?\//u, `${file} imported another local implementation`);
  }
  for (const file of ['record-contract.js', 'pointer-contract.js', 'retention-policy.js', 'store-transaction.js']) {
    const text = await readFile(path.join(nestedRoot, file), 'utf8');
    assert.doesNotMatch(text, /JsonStateStore|StateStore|repository|github|codex|hyper-?v|libvirt|provider|virtual machine|remote agent/iu, `${file} leaked external topology`);
  }

  const importPattern = /from ['"](?:\.\/chat-handoff\/|[^'"]*context\/chat-handoff\/)/u;
  for (const location of await sourceFiles(sourceRoot)) {
    if (location.startsWith(nestedRoot)) continue;
    const text = await readFile(location, 'utf8');
    if (importPattern.test(text)) assert.equal(path.resolve(location), path.resolve(parentPath), `${location} bypassed the parent`);
  }
});
