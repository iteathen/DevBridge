import { createEnvironmentConstructionRuntime } from './environment-construction-runtime.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentLifecycleFence } from './environment-lifecycle-fence.js';
import { createEnvironmentOperator } from './environment-operator.js';
import { createDaemonPauseAdmission } from './daemon-pause-admission.js';
import { invokeCommand } from '../runtime/command-invocation.js';

const STABLE_SUBJECT = /^\d+$/u;

function exactAuthorization() {
  return Object.freeze({
    async verify({ approval, subject }) {
      return Object.freeze({ approved: approval === subject, subject });
    },
  });
}

function localImageAvailability(foundation) {
  if (!foundation || typeof foundation.verifyImage !== 'function' || typeof foundation.observeImage !== 'function') {
    throw new TypeError('local environment image library contract is incomplete');
  }

  const inspect = async ({ identity, generation }) => {
    const verified = await foundation.verifyImage(identity);
    const observed = await foundation.observeImage(identity);
    const actualGeneration = verified?.entry?.generation ?? observed?.entry?.generation ?? null;
    const usable = verified?.verified === true
      && verified?.usable === true
      && observed?.usable === true
      && actualGeneration === generation;
    return Object.freeze({
      state: usable ? 'verified-local' : 'setup-reentry-required',
      localVerified: usable,
      reacquirable: usable ? null : false,
      blocker: usable ? null : 'approved-image-source-or-verified-local-cache-required',
    });
  };

  return Object.freeze({
    inspect,
    async ensure(request) {
      const status = await inspect(request);
      if (!status.localVerified) {
        throw new Error('exact environment image is unavailable locally; setup re-entry is required to select or reacquire an approved image source');
      }
      const image = await foundation.verifyImage(request.identity);
      return Object.freeze({ state: 'local', image });
    },
  });
}

function stableAuthority(value) {
  const subject = String(value ?? '');
  if (!STABLE_SUBJECT.test(subject)) {
    throw new Error('environment workspace authority is not an immutable local subject; setup re-entry is required');
  }
  return subject;
}

export async function createLocalEnvironmentOperator({
  stateDirectory,
  authorityDirectory = null,
  platform = process.platform,
  invoke = invokeCommand,
  foundation = null,
  availability = null,
  fence = null,
  resolveAuthority = stableAuthority,
  resetAuthorization = exactAuthorization(),
  recreateAuthorization = exactAuthorization(),
  now,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('local environment operator stateDirectory is required');
  if (authorityDirectory != null && (typeof authorityDirectory !== 'string' || authorityDirectory.length === 0)) {
    throw new TypeError('local environment operator authorityDirectory must be a non-empty string when provided');
  }
  if (typeof resolveAuthority !== 'function') throw new TypeError('local environment operator authority resolver is required');
  const authorityStateDirectory = authorityDirectory ?? stateDirectory;
  const localFoundation = foundation ?? await createEnvironmentFoundation({ stateDirectory: authorityStateDirectory, platform, invoke });
  const localAvailability = availability ?? localImageAvailability(localFoundation);
  const localFence = fence ?? createEnvironmentLifecycleFence({
    admission: createDaemonPauseAdmission({ stateDirectory }),
  });
  const runtime = await createEnvironmentConstructionRuntime({
    stateDirectory,
    authorityDirectory: authorityStateDirectory,
    platform,
    invoke,
    foundation: localFoundation,
    availability: localAvailability,
    fence: localFence,
    resolveAuthority,
    resetAuthorization,
    recreateAuthorization,
    ...(now ? { now } : {}),
  });
  return createEnvironmentOperator({ runtime });
}
