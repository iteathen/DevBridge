import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointIdFor, classifySensitiveCandidate, decisionIsAccepted, decisionSubjectDigest } from '../src/run/decision-gate.js';
import { parseDecisionEnvelope } from '../src/github/decision-envelope.js';

const RUN = 'pp-27-abcdef';
const REV = 'a'.repeat(64);
const ART = 'b'.repeat(64);

test('decision protocol is closed around exact run/task/checkpoint/subject identity', () => {
  const body = `\`\`\`patch-poller-decision\n${JSON.stringify({ protocol: 'patch-poller/decision-v1', runId: RUN, taskRevision: REV, checkpointId: 'gate-abc', subjectDigest: 'c'.repeat(64), action: 'approve' })}\n\`\`\``;
  const parsed = parseDecisionEnvelope(body);
  assert.equal(parsed.action, 'approve');
  assert.throws(() => parseDecisionEnvelope(`${body}\n${body}`), /exactly one/u);
});

test('artifact-exact binding invalidates approval on any artifact digest change', () => {
  const first = decisionSubjectDigest({ bindingMode: 'artifact-exact', artifactDigest: ART });
  const changed = decisionSubjectDigest({ bindingMode: 'artifact-exact', artifactDigest: 'c'.repeat(64) });
  assert.notEqual(first, changed);
});

test('decision-scope binding survives implementation descendants but changes with material scope', () => {
  const scope = { decisionClass: 'architecture', boundaries: ['port:filesystem', 'module:runtime'], summary: 'Keep the existing port and replace only the adapter.' };
  const first = decisionSubjectDigest({ bindingMode: 'decision-scope', decisionScope: scope });
  const descendant = decisionSubjectDigest({ bindingMode: 'decision-scope', decisionScope: { ...scope, boundaries: [...scope.boundaries].reverse() } });
  const expanded = decisionSubjectDigest({ bindingMode: 'decision-scope', decisionScope: { ...scope, boundaries: [...scope.boundaries, 'schema:public'] } });
  assert.equal(first, descendant);
  assert.notEqual(first, expanded);
});

test('hard-gate decision matches every identity and locally configured actor class', () => {
  const subjectDigest = decisionSubjectDigest({ bindingMode: 'artifact-exact', artifactDigest: ART });
  const checkpoint = { runId: RUN, taskRevision: REV, checkpointId: checkpointIdFor({ runId: RUN, taskRevision: REV, decisionClass: 'security-change', bindingMode: 'artifact-exact', subjectDigest }), subjectDigest, state: 'pending', expiresAt: '2099-01-01T00:00:00Z' };
  const decision = { ...checkpoint, action: 'approve', actorId: '1775584' };
  assert.equal(decisionIsAccepted({ checkpoint, decision, allowedActorIds: new Set(['1775584']), nowMs: 1 }).accepted, true);
  assert.equal(decisionIsAccepted({ checkpoint, decision: { ...decision, subjectDigest: 'd'.repeat(64) }, allowedActorIds: new Set(['1775584']), nowMs: 1 }).reason, 'subject-mismatch');
  assert.equal(decisionIsAccepted({ checkpoint, decision: { ...decision, actorId: '999' }, allowedActorIds: new Set(['1775584']), nowMs: 1 }).reason, 'actor-not-authorized');
});

test('sensitive-path classifier gates security/bootstrap/Git/GitHub/workflow surfaces without gating ordinary source edits', () => {
  assert.equal(classifySensitiveCandidate(['src/domain/math.js']), null);
  assert.deepEqual(classifySensitiveCandidate(['src/domain/math.js', '.github/workflows/ci.yml']).sensitivePaths, ['.github/workflows/ci.yml']);
  assert.deepEqual(classifySensitiveCandidate(['src/security/workspace-policy.js']).decisionClass, 'security-change');
});
