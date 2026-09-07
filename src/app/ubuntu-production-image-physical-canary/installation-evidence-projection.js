export function createInstallationEvidenceProjection({ captureFailure, sanitize }) {
  if (typeof captureFailure !== 'function' || typeof sanitize !== 'function') throw new TypeError('installation evidence projection requires its diagnostic ports');
  return function projectInstallationEvidence(evidence) {
  if (evidence == null) return null;
  const failure = evidence.failure;
  return {
    outcome: failure ? 'failed' : evidence.report?.phase ?? 'unknown',
    observedAt: evidence.reportObservedAt,
    collection: {
      status: evidence.collection.status,
      observedAt: evidence.collection.observedAt,
      reason: evidence.collection.reason == null ? null : sanitize(evidence.collection.reason),
    },
    failure: failure == null ? null : captureFailure({
      stage: failure.stage, attempt: evidence.binding.attempt,
      result: {
        exitCode: failure.exitCode, outputTruncated: failure.truncated || failure.collection === 'partial',
        ...(failure.collection === 'unavailable' ? {} : { stdout: failure.stdout, stderr: failure.stderr }),
      },
    }),
  };
  };
}
