import process from 'node:process';
import { createLocalEnvironmentOperator } from './environment-operator-runtime.js';
import { createLifecycleAuthoritySocketServers } from '../runtime/environment-lifecycle-authority-transport.js';

function requireStateDirectory(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is required`);
  return value;
}

function assertOperator(value) {
  const methods = ['inspect', 'list', 'status', 'plan', 'run', 'resume', 'setupReentry'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('environment lifecycle authority host operator contract is incomplete');
  }
  return value;
}

export async function createEnvironmentLifecycleAuthorityHost({
  stateDirectory,
  endpointStateDirectory = stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  operator = null,
  operatorOptions = {},
} = {}) {
  const protectedState = requireStateDirectory(stateDirectory, 'environment lifecycle authority host protected stateDirectory');
  const endpointState = requireStateDirectory(endpointStateDirectory, 'environment lifecycle authority host endpoint stateDirectory');
  if (!operatorOptions || typeof operatorOptions !== 'object' || Array.isArray(operatorOptions)) {
    throw new TypeError('environment lifecycle authority host operatorOptions must be an object');
  }
  const localOperator = operator == null
    ? await createLocalEnvironmentOperator({ stateDirectory: protectedState, platform, ...operatorOptions })
    : assertOperator(operator);
  const servers = createLifecycleAuthoritySocketServers({
    operator: localOperator,
    stateDirectory: endpointState,
    platform,
    runDirectory,
  });

  let started = false;
  return Object.freeze({
    authorityIdentity: servers.authorityIdentity,
    async start() {
      if (started) return this;
      await servers.read.start();
      try {
        await servers.mutation.start();
      } catch (error) {
        await servers.read.close();
        throw error;
      }
      started = true;
      return this;
    },
    async close() {
      if (!started) return;
      started = false;
      let failure = null;
      try { await servers.mutation.close(); } catch (error) { failure = error; }
      try { await servers.read.close(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    },
  });
}
