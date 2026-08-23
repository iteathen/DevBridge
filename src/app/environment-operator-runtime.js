import { createEnvironmentConstructionRuntime } from './environment-construction-runtime.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentOperator } from './environment-operator.js';
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
  platform = process.platform,
  invoke = invokeCommand,
  windowsAccess = null,
  foundation = null,
  availability = null,
  resolveAuthority = stableAuthority,
  resetAuthorization = exactAuthorization(),
  recreateAuthorization = exactAuthorization(),
  now,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('local environment operator stateDirectory is required');
  if (typeof resolveAuthority !== 'function') throw new TypeError('local environment operator authority resolver is required');
  const localFoundation = foundation ?? await createEnvironmentFoundation({ stateDirectory, platform, invoke });
  const localAvailability = availability ?? localImageAvailability(localFoundation);
  const runtime = await createEnvironmentConstructionRuntime({
    stateDirectory,
    platform,
    invoke,
    windowsAccess,
    foundation: localFoundation,
    availability: localAvailability,
    resolveAuthority,
    resetAuthorization,
    recreateAuthorization,
    ...(now ? { now } : {}),
  });
  return createEnvironmentOperator({ runtime });
}
