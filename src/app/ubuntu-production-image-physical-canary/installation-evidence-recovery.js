export function createInstallationEvidenceRecovery({ checkpoint, inspect }) {
  if (typeof checkpoint !== 'function' || typeof inspect !== 'function') throw new TypeError('installation evidence recovery requires its evidence ports');
  return async function recoverInstallationEvidence({ previous, observe, now }) {
  try {
    const observed = await observe();
    const evidence = inspect(observed?.installationEvidence, previous.binding);
    if (!evidence?.failure || evidence.failure.stage !== previous.failure.stage
        || evidence.failure.exitCode !== previous.failure.exitCode
        || evidence.failure.sequence < previous.failure.sequence
        || (previous.failure.collection === 'complete' && evidence.failure.collection !== 'complete')) {
      throw new Error('diagnostic recovery did not retain the saved failure');
    }
    return { installationEvidence: evidence, liveness: observed.liveness ?? null };
  } catch {
    return {
      liveness: null,
      installationEvidence: checkpoint({
        binding: previous.binding, previous, now: now(),
        observation: { status: 'unavailable', reason: 'installer diagnostic recovery failed; saved failure retained' },
      }),
    };
  }
  };
}
