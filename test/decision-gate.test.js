import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DecisionGate,
  buildCandidateManifest,
  classifySensitiveCandidate,
  decisionScopeDigest,
  decisionSubjectMatches,
} from '../src/run/decision-gate.js';

const revision = 'a'.repeat(64);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-decision-gate-'));
  await writeFile(path.join(root, 'src-config.js'), 'one\n');
  return {
    root,
    workspace: { worktreeDir: root, baseSha: '1'.repeat(40), branch: 'fixture' },
    snapshot: { changedFiles: ['src/config.js'], dirty: true, branch: 'fixture', baseSha: '1'.repeat(40), headSha: '1'.repeat(40) },
    task: { issueNumber: 27, revision },
    state: { runId: 'run-27', checkpoints: [], lastDecisionCommentId: 0 },
  };
}

async function writeSensitiveFile(root, text) {
  const target = path.join(root, 'src', 'config.js');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(target), { recursive: true }));
  await writeFile(target, text);
}

test('candidate manifests bind exact bytes and normalized decision scopes are stable', async () => {
  const data = await fixture();
  try {
    await writeSensitiveFile(data.root, 'alpha\n');
    const first = await buildCandidateManifest(data.workspace, data.snapshot);
    await writeSensitiveFile(data.root, 'beta\n');
    const second = await buildCandidateManifest(data.workspace, data.snapshot);
    assert.notEqual(first.digest, second.digest);
    const a = decisionScopeDigest({ decisionClass: 'security-policy', baselineSha: data.workspace.baseSha, bounds: ['b', 'a'] });
    const b = decisionScopeDigest({ decisionClass: 'security-policy', baselineSha: data.workspace.baseSha, bounds: ['a', 'b', 'a'] });
    assert.equal(a, b);
    assert.equal(decisionSubjectMatches({ bindingMode: 'decision-scope', subjectDigest: a }, { scopeDigest: b }), true);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('sensitive path classification is local and deterministic', () => {
  assert.equal(classifySensitiveCandidate(['src/config.js']), 'security-policy');
  assert.equal(classifySensitiveCandidate(['src/bootstrap/transactional-bootstrap.mjs']), 'bootstrap-self-update');
  assert.equal(classifySensitiveCandidate(['src/github/rest-client.js']), 'git-github-control');
  assert.equal(classifySensitiveCandidate(['specs/PP-001-system.md']), 'public-contract');
  assert.equal(classifySensitiveCandidate(['src/feature.js']), null);
});

test('hard gate remains pending on silence and approves only exact run/task/checkpoint/digest authority', async () => {
  const data = await fixture();
  try {
    await writeSensitiveFile(data.root, 'alpha\n');
    const silent = new DecisionGate({ authorityClasses: { 'security-policy': ['1775584'] }, now: () => Date.parse('2026-08-18T20:00:00Z') });
    const pending = await silent.evaluate(data);
    assert.equal(pending.allowed, false);
    assert.equal(pending.checkpoint.status, 'pending');

    const source = {
      pollDecision: async (request) => ({
        highestCommentId: 40,
        decision: {
          protocol: 'patch-poller/decision-v1',
          runId: request.runId,
          taskRevision: request.taskRevision,
          checkpointId: request.checkpointId,
          subjectDigest: request.subjectDigest,
          action: 'approve',
          actorId: '1775584',
          commentId: 40,
          contentSha256: 'c'.repeat(64),
        },
      }),
    };
    const approving = new DecisionGate({ decisionSource: source, authorityClasses: { 'security-policy': ['1775584'] }, now: () => Date.parse('2026-08-18T20:00:01Z') });
    const approved = await approving.evaluate(data);
    assert.equal(approved.allowed, true);
    assert.equal(approved.checkpoint.status, 'approved');
    assert.equal(data.state.lastDecisionCommentId, 40);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('changed candidate bytes supersede artifact-exact approval instead of stretching it', async () => {
  const data = await fixture();
  let approvals = 0;
  try {
    await writeSensitiveFile(data.root, 'alpha\n');
    const source = {
      pollDecision: async (request) => {
        approvals += 1;
        if (approvals > 1) return { highestCommentId: 50, decision: null };
        return {
          highestCommentId: 50,
          decision: {
            runId: request.runId, taskRevision: request.taskRevision, checkpointId: request.checkpointId,
            subjectDigest: request.subjectDigest, action: 'approve', actorId: '1775584', commentId: 50,
            contentSha256: 'd'.repeat(64),
          },
        };
      },
    };
    const gate = new DecisionGate({ decisionSource: source, authorityClasses: { 'security-policy': ['1775584'] }, now: () => Date.parse('2026-08-18T20:00:00Z') });
    const first = await gate.evaluate(data);
    assert.equal(first.allowed, true);
    const approvedId = first.checkpoint.checkpointId;
    await writeSensitiveFile(data.root, 'changed after approval\n');
    const second = await gate.evaluate(data);
    assert.equal(second.allowed, false);
    assert.equal(second.checkpoint.status, 'pending');
    assert.notEqual(second.checkpoint.checkpointId, approvedId);
    assert.equal(data.state.checkpoints.find((entry) => entry.checkpointId === approvedId).status, 'superseded');
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('approved checkpoints expire under local TTL policy and cannot cross the sealing frontier', async () => {
  const data = await fixture();
  let now = Date.parse('2026-08-18T20:00:00Z');
  try {
    await writeSensitiveFile(data.root, 'alpha\n');
    const source = {
      pollDecision: async (request) => ({ highestCommentId: 60, decision: {
        runId: request.runId, taskRevision: request.taskRevision, checkpointId: request.checkpointId,
        subjectDigest: request.subjectDigest, action: 'approve', actorId: '1775584', commentId: 60,
        contentSha256: 'e'.repeat(64),
      } }),
    };
    const gate = new DecisionGate({ decisionSource: source, authorityClasses: { 'security-policy': ['1775584'] }, ttlMs: 60_000, now: () => now });
    assert.equal((await gate.evaluate(data)).allowed, true);
    now += 60_001;
    const expired = await gate.evaluate(data);
    assert.equal(expired.allowed, false);
    assert.equal(expired.checkpoint.status, 'expired');
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});
