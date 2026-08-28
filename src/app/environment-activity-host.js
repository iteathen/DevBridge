import process from 'node:process';
import { createEnvironmentActivityRuntime } from './environment-activity-runtime.js';
import { createEnvironmentBridgeExchange } from './environment-bridge.js';
import { createEnvironmentConstructionPreparation } from './environment-construction-preparation.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { loadEnvironmentActivityPolicy } from '../runtime/environment-activity-policy.js';

function directory(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function assertState(value) {
  const methods = ['inspect', 'listEnvironments', 'observeEnvironment'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('protected activity state contract is incomplete');
  return value;
}

function assertDeclarations(value) {
  if (!value || typeof value.list !== 'function') throw new TypeError('protected activity declaration contract is incomplete');
  return value;
}

function assertPreparation(value) {
  if (!value || typeof value.ensure !== 'function' || typeof value.connection !== 'function') {
    throw new TypeError('protected activity preparation contract is incomplete');
  }
  return value;
}

function exactEnvironment(value) {
  if (typeof value !== 'string' || !/^env-[a-f0-9]{32}$/u.test(value)) throw new TypeError('protected activity target is invalid');
  return value;
}

export async function createProtectedEnvironmentActivity({
  stateDirectory,
  authorityDirectory = null,
  platform = process.platform,
  invoke = invokeCommand,
  windowsAccess = null,
  state = null,
  declarations = null,
  preparation = null,
  bridgeExchange = null,
  policyLoader = loadEnvironmentActivityPolicy,
} = {}) {
  const ordinary = directory(stateDirectory, 'protected activity stateDirectory');
  const authority = authorityDirectory == null ? ordinary : directory(authorityDirectory, 'protected activity authorityDirectory');
  if (typeof invoke !== 'function') throw new TypeError('protected activity invocation contract is invalid');
  if (typeof policyLoader !== 'function') throw new TypeError('protected activity policy loader is invalid');
  if (bridgeExchange != null && typeof bridgeExchange !== 'function') throw new TypeError('protected activity bridge exchange is invalid');

  const selectedState = assertState(state ?? await createEnvironmentFoundation({ stateDirectory: authority, platform, invoke }));
  const selectedDeclarations = assertDeclarations(declarations ?? createEnvironmentLifecycle({ stateDirectory: authority }).declarations);
  const selectedPreparation = assertPreparation(preparation ?? createEnvironmentConstructionPreparation({
    stateDirectory: ordinary,
    authorityDirectory: authority,
    platform,
    invoke,
    windowsAccess,
  }));

  const requestFor = async (rawTarget) => {
    const target = exactEnvironment(rawTarget);
    const observed = await selectedState.observeEnvironment(target);
    if (observed?.record?.identity !== target || typeof observed?.record?.profile !== 'string') {
      throw new Error('protected activity target observation is invalid');
    }
    const matches = (await selectedDeclarations.list()).filter((entry) => entry?.declaration?.profile === observed.record.profile);
    if (matches.length !== 1) throw new Error('protected activity target declaration is unavailable or ambiguous');
    const declaration = matches[0].declaration;
    return Object.freeze({
      declaration,
      implementationGeneration: target,
      bootstrap: declaration.bootstrap,
      enrollment: declaration.enrollment,
    });
  };

  const identity = await selectedState.inspect();
  if (typeof identity?.identity !== 'string') throw new Error('protected activity foundation identity is unavailable');
  const selectedExchange = bridgeExchange ?? await createEnvironmentBridgeExchange({
    stateDirectory: authority,
    foundationIdentity: identity.identity,
    platform,
    invoke,
    access: async (target) => selectedPreparation.connection(await requestFor(target), target),
  });

  return createEnvironmentActivityRuntime({
    state: selectedState,
    loadPolicy: () => policyLoader(ordinary),
    preparation: Object.freeze({
      async ensure(target) {
        const result = await selectedPreparation.ensure(await requestFor(target));
        if (result?.ready !== true || result.implementationGeneration !== target) {
          throw new Error('protected activity preparation evidence changed');
        }
        return Object.freeze({ generation: result.implementationGeneration });
      },
    }),
    exchange: selectedExchange,
  });
}
