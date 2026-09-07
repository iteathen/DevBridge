import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkpointConstructionInstallEvidence, decodeInstallerEvidence,
  INSTALLER_EVIDENCE_MAX_BYTES, INSTALLER_EVIDENCE_PROTOCOL,
} from '../src/runtime/construction-install-evidence.js';

const binding = Object.freeze({ subject: 'subject-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', providerInstance: 'provider-instance-1', seedSha256: 'b'.repeat(64), attempt: 1 });
const now = new Date('2026-09-06T03:00:00Z');
function frame(overrides = {}) {
  return Buffer.from(JSON.stringify({
    protocol: INSTALLER_EVIDENCE_PROTOCOL, identity: binding.subject, attempt: 1,
    sequence: 2, phase: 'failed', stage: 'apt-install', exitCode: 100,
    collection: 'complete', truncated: false, stdoutBase64: '',
    stderrBase64: Buffer.from('unmet dependencies').toString('base64'), ...overrides,
  }));
}
function collect(previous = null, bytes = frame(), selected = binding) {
  return checkpointConstructionInstallEvidence({ binding: selected, previous, observation: { status: 'available', bytes }, now });
}

test('an exact failure retains useful output and survives durable JSON recovery and collection loss', () => {
  const first = collect();
  assert.equal(first.failure.exitCode, 100);
  assert.equal(first.failure.stderr, 'unmet dependencies');
  const recovered = checkpointConstructionInstallEvidence({
    binding, previous: JSON.parse(JSON.stringify(first)), now: new Date(now.getTime() + 1000),
    observation: { status: 'unavailable', reason: 'endpoint unavailable' },
  });
  assert.deepEqual(recovered.failure, first.failure);
  assert.equal(recovered.collection.status, 'unavailable');
  assert.equal(recovered.reportObservedAt, first.reportObservedAt);
  assert.equal(collect(recovered).collection.status, 'available');
});

test('stale, contradictory and altered same-sequence records cannot erase a failure', () => {
  const first = collect();
  for (const [change, status] of [
    [{ sequence: 1 }, 'stale'],
    [{ stage: 'different-stage' }, 'invalid'],
    [{ sequence: 3, phase: 'finished', exitCode: 0 }, 'invalid'],
    [{ sequence: 3, phase: 'installing', exitCode: null }, 'invalid'],
    [{ sequence: 3, exitCode: 17 }, 'invalid'],
  ]) {
    const result = collect(first, frame(change));
    assert.equal(result.collection.status, status);
    assert.deepEqual(result.failure, first.failure);
    assert.deepEqual(result.report, first.report);
  }
});

test('a known terminal failure can acquire diagnostics without losing its exit status', () => {
  const first = collect(null, frame({ collection: 'unavailable', stderrBase64: '' }));
  const enriched = collect(first, frame());
  assert.equal(enriched.failure.stderr, 'unmet dependencies');
  const unavailable = collect(enriched, frame({ collection: 'unavailable', stderrBase64: '' }));
  assert.equal(unavailable.collection.status, 'available');
  assert.equal(unavailable.failure.stderr, 'unmet dependencies');
  assert.equal(unavailable.report.collection, 'unavailable');
  const refreshed = collect(unavailable, frame({ stderrBase64: Buffer.from('same failure, later diagnostic tail').toString('base64') }));
  assert.equal(refreshed.failure.sequence, first.failure.sequence);
  assert.equal(refreshed.failure.stderr, 'same failure, later diagnostic tail');
});

test('provider, attempt and immutable seed identities fence saved evidence', () => {
  const first = collect();
  for (const change of [{ providerInstance: 'replacement' }, { attempt: 2 }, { subject: 'different' }, { seedSha256: 'c'.repeat(64) }]) {
    assert.throws(() => collect(first, frame(), { ...binding, ...change }), /binding changed/u);
  }
  for (const change of [{ identity: 'other-task' }, { attempt: 2 }, { providerInstance: 'forged' }, { protocol: 'unknown' }]) {
    assert.equal(collect(null, frame(change)).collection.status, 'invalid');
  }
});

test('malformed frames, UTF8, noncanonical encodings and excess output remain collection failures', () => {
  for (const bytes of [
    Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(INSTALLER_EVIDENCE_MAX_BYTES + 1),
    frame({ stderrBase64: 'not base64!' }), frame({ stderrBase64: '/w==' }),
    frame({ stderrBase64: Buffer.alloc(16 * 1024 + 1).toString('base64') }),
    frame({ phase: 'failed', exitCode: 0 }), frame({ exitCode: 256 }),
    frame({ collection: 'unavailable' }), frame({ sequence: 0 }), frame({ stage: '../other' }),
  ]) {
    const result = collect(null, bytes);
    assert.equal(result.collection.status, 'invalid');
    assert.equal(result.failure, null);
  }
  assert.equal(decodeInstallerEvidence(frame({ exitCode: null, collection: 'partial', truncated: true }), binding).exitCode, null);
});

test('guest completion is merely a report and corrupt saved evidence cannot be adopted', () => {
  const finished = collect(null, frame({ phase: 'finished', exitCode: 0 }));
  assert.equal(finished.failure, null);
  assert.equal(Object.hasOwn(finished, 'ready'), false);
  assert.throws(() => collect({ ...finished, reportSha256: '0'.repeat(64) }), /inconsistent/u);
  assert.throws(() => collect({ ...finished, binding: { ...binding, hostPath: 'unexpected' } }), /fields/u);
  const failed = collect();
  assert.throws(() => collect({ ...failed, failure: null, failureSha256: null }), /inconsistent/u);
  assert.throws(() => collect({ ...failed, failure: { ...failed.failure, stderr: 'changed' } }), /inconsistent/u);
});
