import { RepositoryCatalog } from '../github/repository-catalog.js';
import { createGitHubSession } from './github-session.js';
import { createRuntime } from './runtime.js';

export async function createRuntimeSet(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  coordinationExclusive = false,
  sessionFactory = createGitHubSession,
  catalogFactory = (options) => new RepositoryCatalog(options),
  runtimeFactory = createRuntime,
} = {}) {
  if (typeof coordinationExclusive !== 'boolean') throw new TypeError('createRuntimeSet coordinationExclusive must be a boolean');
  const session = await sessionFactory(config, { env, fetchImpl });
  const catalog = catalogFactory({
    client: session.client,
    stateStore: session.stateStore,
    configuredRepositories: config.github.queueRepositories,
    allowedOwners: config.workspace.allowedOwners,
    discovery: config.github.repositoryDiscovery,
  });
  if (!catalog || typeof catalog.list !== 'function') throw new TypeError('repository catalog contract is incomplete');
  const selection = await catalog.list();
  if (!Array.isArray(selection.repositories) || selection.repositories.length === 0) {
    throw new Error('repository selection produced no queue repositories');
  }
  const runtimes = [];
  for (const queueRepository of selection.repositories) {
    runtimes.push(await runtimeFactory(config, {
      env,
      fetchImpl,
      coordinationExclusive,
      queueRepository,
      githubSession: session,
    }));
  }
  return Object.freeze({
    config,
    session,
    selection,
    runtimes: Object.freeze(runtimes),
  });
}
