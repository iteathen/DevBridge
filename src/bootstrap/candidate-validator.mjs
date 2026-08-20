import path from 'node:path';
import { runtimeArtifactSha256 } from './release-integrity.mjs';

const UNAVAILABLE_REASON = 'candidate-controlled execution is unavailable until VM Stage 6 restores repository execution';

function fail(message) { throw new Error(message); }

export async function validateRuntimeCandidate(_paths, runtime, _legacyRunner = null, {
  expectedArtifactSha256 = null,
} = {}) {
  const runtimeDir = path.resolve(runtime.runtimeDir);
  const artifact = await runtimeArtifactSha256(runtimeDir);
  if (expectedArtifactSha256 && artifact.sha256 !== expectedArtifactSha256) {
    fail(`candidate artifact changed before validation; expected ${expectedArtifactSha256}, observed ${artifact.sha256}`);
  }
  fail(UNAVAILABLE_REASON);
}

export function candidateValidationAvailability() {
  return Object.freeze({
    state: 'unavailable',
    ready: false,
    reason: UNAVAILABLE_REASON,
  });
}
