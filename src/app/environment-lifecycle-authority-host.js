import process from 'node:process';
import { createLocalEnvironmentOperator } from './environment-operator-runtime.js';
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

export async function createEnvironmentLifecycleAuthorityHost({
  stateDirectory,
  authorityDirectory = null,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  operator = null,
  operatorOptions = {},
} = {}) {
  const state = requireStateDirectory(stateDirectory);
  const authority = requireAuthorityDirectory(authorityDirectory, state);
  if (!operatorOptions || typeof operatorOptions !== 'object' || Array.isArray(operatorOptions)) {
    throw new TypeError('environment lifecycle authority host operatorOptions must be an object');
  }
  const localOperator = operator == null
    ? await createLocalEnvironmentOperator({ ...operatorOptions, stateDirectory: state, authorityDirectory: authority, platform })
    : assertOperator(operator);
  const servers = createLifecycleAuthoritySocketServers({
    operator: localOperator,
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
