import path from 'node:path';
import { resolveGitHubCredential } from '../github/auth-provider.js';
import { RateBudget } from '../github/rate-budget.js';
import { GitHubRestClient } from '../github/rest-client.js';
import { JsonStateStore } from '../state/json-state-store.js';

export async function createGitHubSession(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!config?.github || typeof config?.state?.directory !== 'string') {
    throw new TypeError('GitHub session configuration is incomplete');
  }
  const stateStore = new JsonStateStore(path.join(config.state.directory, 'github-control.json'));
  const rateBudget = new RateBudget(config.github.rateLimit);
  const credential = await resolveGitHubCredential(config.github.auth, { env });
  const tokenProvider = async () => credential?.token ?? null;
  const client = new GitHubRestClient({
    apiVersion: config.github.apiVersion,
    tokenProvider,
    stateStore,
    rateBudget,
    mutationIntervalMs: config.github.rateLimit.mutationIntervalMs,
    fetchImpl,
  });
  return Object.freeze({
    client,
    credential,
    rateBudget,
    stateStore,
    tokenProvider,
    secretValues: Object.freeze(credential ? [credential.token] : []),
  });
}
