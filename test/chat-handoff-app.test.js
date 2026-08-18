import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatHandoffSeed, chatHandoffStatus, createLocalChatHandoffStore } from '../src/app/chat-handoff.js';
import { CHAT_HANDOFF_PROTOCOL, chatHandoffDigest, parseChatResumeSeed } from '../src/context/chat-handoff.js';

function config(stateDirectory) {
  return {
    github: { queueRepository: 'iteathen/PATCH-POLLER' },
    state: { directory: stateDirectory },
    contextRollover: { maxHandoffBytes: 32_768, maxRetained: 8 },
  };
}

function fixture() {
  return {
    protocol: CHAT_HANDOFF_PROTOCOL,
    handoffId: 'ui-rollover-fixture',
    sequence: 1,
    repository: 'iteathen/PATCH-POLLER',
    baselineSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'sol/pp-014-context-rollover',
    issueNumber: 20,
    prNumber: 21,
    runId: 'pp014-ui-fixture',
    phase: 'testing',
    completedActionIds: ['implement-core'],
    nextActionId: 'observe-ci',
    decisions: [],
    blockers: [],
    evidenceRefs: [{ id: 'core', kind: 'commit', locator: `commit:${'b'.repeat(40)}`, sha256: null }],
    governingDocs: [],
    previousHandoffDigest: null,
    createdAt: '2026-08-18T18:15:00.000Z',
  };
}

test('local handoff status and seed require no GitHub credential or remote request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-chat-handoff-app-'));
  const localConfig = config(directory);
  const store = createLocalChatHandoffStore(localConfig);
  const checkpoint = await store.checkpoint(fixture());

  const status = await chatHandoffStatus(localConfig);
  assert.equal(status.ready, true);
  assert.equal(status.handoffId, 'ui-rollover-fixture');
  assert.equal(status.digest, checkpoint.record.digest);
  assert.equal(status.nextActionId, 'observe-ci');
  assert.deepEqual(status.handoff, checkpoint.record.handoff);

  const seed = await chatHandoffSeed(localConfig);
  assert.equal(seed, status.seed);
  const parsed = parseChatResumeSeed(seed);
  assert.equal(parsed.digest, chatHandoffDigest(fixture()));
  assert.equal(parsed.repository, 'iteathen/PATCH-POLLER');
});

test('local handoff status reports absence without creating remote authority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-chat-handoff-empty-'));
  const status = await chatHandoffStatus(config(directory));
  assert.deepEqual(status, { ready: false, repository: 'iteathen/PATCH-POLLER' });
  assert.equal(await chatHandoffSeed(config(directory)), null);
});
