import process from 'node:process';
import { createLocalEnvironmentOperator } from './environment-operator-runtime.js';
import { createEnvironmentConfigurationSocketServer } from '../runtime/environment-configuration-authority-transport.js';
import { createLifecycleAuthoritySocketServers } from '../runtime/environment-lifecycle-authority-transport.js';

function requireStateDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('environment lifecycle authority host stateDirectory is required');
  return value;
}

function requireAuthorityDirectory(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('environment lifecycle authority host authorityDirectory must be a non-empty string when provided');
  return value;
}

function assertOperator(value) {
  const methods = ['inspect', 'list', 'status', 'plan', 'run', 'resume', 'setupReentry'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('environment lifecycle authority host operator contract is incomplete');
  }
  return value;
}

function assertConfiguration(value) {
  if (value == null) return null;
  if (typeof value.inspect !== 'function' || typeof value.reconcile !== 'function') {
    throw new TypeError('environment configuration host contract is incomplete');
  }
  return value;
}

function assertServerFactory(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

export async function createEnvironmentLifecycleAuthorityHost({
  stateDirectory,
  authorityDirectory = null,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  operator = null,
  configuration = null,
  fence = null,
} = {}, {
  lifecycleServerFactory = createLifecycleAuthoritySocketServers,
  configurationServerFactory = createEnvironmentConfigurationSocketServer,
} = {}) {
  const state = requireStateDirectory(stateDirectory);
  const authority = requireAuthorityDirectory(authorityDirectory, state);
  const selectedConfiguration = assertConfiguration(configuration);
  const createLifecycleServers = assertServerFactory(lifecycleServerFactory, 'environment lifecycle authority server factory');
  const createConfigurationServer = selectedConfiguration == null
    ? null
    : assertServerFactory(configurationServerFactory, 'environment configuration authority server factory');
  if (operator == null && platform === 'linux' && (!fence || typeof fence.acquire !== 'function')) {
    throw new TypeError('Linux environment lifecycle authority host requires an activity fence');
  }
  const localOperator = operator == null
    ? await createLocalEnvironmentOperator({ stateDirectory: state, authorityDirectory: authority, platform, ...(fence == null ? {} : { fence }) })
    : assertOperator(operator);
  const servers = createLifecycleServers({
    operator: localOperator,
    stateDirectory: state,
    platform,
    runDirectory,
  });
  const configurationServer = selectedConfiguration == null
    ? null
    : createConfigurationServer({
      configuration: selectedConfiguration,
      stateDirectory: state,
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
      try {
        await configurationServer?.start();
      } catch (error) {
        let rollbackFailure = null;
        try { await servers.mutation.close(); } catch (failure) { rollbackFailure = failure; }
        try { await servers.read.close(); } catch (failure) { rollbackFailure ??= failure; }
        throw rollbackFailure ?? error;
      }
      started = true;
      return this;
    },
    async close() {
      if (!started) return;
      started = false;
      let failure = null;
      try { await configurationServer?.close(); } catch (error) { failure = error; }
      try { await servers.mutation.close(); } catch (error) { failure ??= error; }
      try { await servers.read.close(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    },
  });
}
