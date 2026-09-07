import { assertGitHubRuntimeContext, createGitHubRuntimeContext } from './github-runtime-context.js';
import { createRuntime } from './runtime.js';

export const RUNTIME_COLLECTION_PROTOCOL = 'devbridge/runtime-collection-v1';

function assertRuntime(value, subject, context) {
  if (!value || value.queueRepository !== subject || value.githubContext !== context
      || !value.stateStore || !value.rateBudget || !value.taskSource) {
    throw new Error('runtime collection member does not match its subject');
  }
  return value;
}

export async function createRuntimeCollection(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  coordinationExclusive = false,
  contextFactory = createGitHubRuntimeContext,
  runtimeFactory = createRuntime,
} = {}) {
  const subjects = config?.github?.queueRepositories;
  if (!Array.isArray(subjects) || subjects.length === 0) throw new TypeError('runtime collection subjects are unavailable');
  if (typeof contextFactory !== 'function' || typeof runtimeFactory !== 'function') throw new TypeError('runtime collection composition is incomplete');
  const githubContext = assertGitHubRuntimeContext(await contextFactory({
    apiVersion: config.github.apiVersion,
    rateLimit: config.github.rateLimit,
    auth: config.github.auth,
    stateDirectory: config.state.directory,
    env,
    fetchImpl,
  }));
  const runtimes = [];
  for (const subject of subjects) {
    const runtime = await runtimeFactory(config, {
      env,
      fetchImpl,
      coordinationExclusive,
      queueRepository: subject,
      githubContext,
    });
    runtimes.push(assertRuntime(runtime, subject, githubContext));
  }
  return Object.freeze({
    protocol: RUNTIME_COLLECTION_PROTOCOL,
    config,
    githubContext,
    runtimes: Object.freeze(runtimes),
  });
}
