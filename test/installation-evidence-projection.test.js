import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallationEvidenceProjection } from '../src/app/ubuntu-production-image-physical-canary/installation-evidence-projection.js';
import { captureFailureDiagnostics } from '../src/run/failure-diagnostics.js';
import { sanitizeDiagnosticText } from '../src/security/diagnostic-redaction.js';

const projectInstallationEvidence = createInstallationEvidenceProjection({ captureFailure: captureFailureDiagnostics, sanitize: sanitizeDiagnosticText });

function evidence(failure) {
  return {
    binding: { subject: 'local-subject', providerInstance: 'private-provider-id', seedSha256: 'private-seed-identity', attempt: 2 },
    reportObservedAt: '2026-09-06T03:00:00Z',
    collection: { status: 'unavailable', observedAt: '2026-09-06T03:01:00Z', reason: 'cannot read C:\\private\\record' },
    failure,
  };
}

test('public installation errors preserve useful failure text while redacting before tail truncation', () => {
  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'private-key-body'.repeat(650)}\n-----END OPENSSH PRIVATE KEY-----`;
  const result = projectInstallationEvidence(evidence({
    stage: 'apt-install', exitCode: 100, collection: 'complete', truncated: false,
    stdout: '', stderr: `${key}\nAPI_KEY=hidden-value\n/target/private/result\nunmet dependencies`,
  }));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure.exitCode, 100);
  assert.equal(result.failure.attempt, 2);
  assert.match(result.failure.stderr, /unmet dependencies/u);
  const text = JSON.stringify(result);
  for (const secret of ['private-key-body', 'hidden-value', '/target/private', 'C:\\private', 'private-provider-id', 'private-seed-identity']) assert.equal(text.includes(secret), false);
  assert.equal(result.collection.status, 'unavailable');
  assert.equal(result.failure.collection, 'available');
});

test('missing original diagnostics remain distinct from a later failed transport', () => {
  const result = projectInstallationEvidence(evidence({ stage: 'installer', exitCode: null, collection: 'unavailable', truncated: true, stdout: '', stderr: '' }));
  assert.equal(result.failure.collection, 'unavailable');
  assert.equal(result.failure.exitCode, null);
  assert.equal(result.failure.truncated, true);
  assert.equal(result.collection.status, 'unavailable');
  assert.equal(projectInstallationEvidence(null), null);
});
