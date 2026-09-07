import path from 'node:path';
import { GitHubRestClient } from '../github/rest-client.js';
import { resolveGitHubCredential } from '../github/auth-provider.js';
import { RateBudget } from '../github/rate-budget.js';
import { JsonStateStore } from '../state/json-state-store.js';

export const GITHUB_RUNTIME_CONTEXT_PROTOCOL = 'devbridge/github-runtime-context-v1';

export async function createGitHubRuntimeContext({
  apiVersion,
  rateLimit,
  auth,
  stateDirectory,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiVersion !== 'string' || apiVersion.length === 0 || !rateLimit || !auth) {
    throw new TypeError('GitHub runtime configuration is invalid');
  }
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('GitHub runtime stateDirectory is required');
  const stateStore = new JsonStateStore(path.join(path.resolve(stateDirectory), 'github-runtime.json'));
  const rateBudget = new RateBudget(rateLimit);
  const credential = await resolveGitHubCredential(auth, { env });
  const tokenProvider = async () => credential?.token ?? null;
  const client = new GitHubRestClient({
    apiVersion,
    tokenProvider,
    stateStore,
    rateBudget,
    mutationIntervalMs: rateLimit.mutationIntervalMs,
    fetchImpl,
  });
  return Object.freeze({
    protocol: GITHUB_RUNTIME_CONTEXT_PROTOCOL,
    stateStore,
    rateBudget,
    tokenProvider,
    client,
    secretValues: Object.freeze(credential ? [credential.token] : []),
  });
}

export function assertGitHubRuntimeContext(value) {
  if (!value || value.protocol !== GITHUB_RUNTIME_CONTEXT_PROTOCOL
      || !value.stateStore || !value.rateBudget || typeof value.rateBudget.snapshot !== 'function'
      || typeof value.rateBudget.recommendedPollIntervalMs !== 'function' || !value.client
      || typeof value.tokenProvider !== 'function' || !Array.isArray(value.secretValues)) {
    throw new TypeError('GitHub runtime context contract is incomplete');
  }
  return value;
}
