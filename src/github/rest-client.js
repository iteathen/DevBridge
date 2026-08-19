import { createHash } from 'node:crypto';
import { HttpError, RateLimitError } from '../errors.js';
import { RateBudget } from './rate-budget.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(url) {
  return `github.etag.${createHash('sha256').update(url).digest('hex')}`;
}

function isMutation(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

export class GitHubRestClient {
  #baseUrl;
  #apiVersion;
  #tokenProvider;
  #stateStore;
  #rateBudget;
  #fetch;
  #serial = Promise.resolve();
  #lastMutationAt = 0;
  #mutationIntervalMs;
  #now;
  #sleep;

  constructor({
    baseUrl = 'https://api.github.com',
    apiVersion = '2026-03-10',
    tokenProvider,
    stateStore,
    rateBudget,
    mutationIntervalMs = 1100,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    sleepImpl = sleep
  }) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#apiVersion = apiVersion;
    this.#tokenProvider = tokenProvider;
    this.#stateStore = stateStore;
    this.#rateBudget = rateBudget ?? new RateBudget();
    this.#fetch = fetchImpl;
    this.#mutationIntervalMs = mutationIntervalMs;
    this.#now = now;
    this.#sleep = sleepImpl;
  }

  get rateBudget() {
    return this.#rateBudget;
  }

  #absoluteUrl(requestPath) {
    return requestPath.startsWith('http')
      ? requestPath
      : `${this.#baseUrl}${requestPath.startsWith('/') ? '' : '/'}${requestPath}`;
  }

  request(method, requestPath, options = {}) {
    const normalized = method.toUpperCase();
    const work = () => this.#requestNow(normalized, requestPath, options);
    const result = this.#serial.then(work, work);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }

  async graphql(query, variables = {}, { critical = false } = {}) {
    if (typeof query !== 'string' || query.trim() === '') throw new TypeError('GraphQL query must be a non-empty string');
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new TypeError('GraphQL variables must be an object');
    const response = await this.request('POST', '/graphql', {
      body: { query, variables },
      critical,
      mutation: false,
    });
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
      throw new HttpError('GitHub GraphQL response is malformed', { status: response.status, body: response.data });
    }
    if (Array.isArray(response.data.errors) && response.data.errors.length > 0) {
      throw new HttpError('GitHub GraphQL query returned errors', {
        status: response.status,
        body: { errors: response.data.errors.map((entry) => ({ message: String(entry?.message ?? 'GraphQL error') })) },
      });
    }
    if (!Object.hasOwn(response.data, 'data')) {
      throw new HttpError('GitHub GraphQL response omitted data', { status: response.status, body: response.data });
    }
    return { ...response, data: response.data.data, extensions: response.data.extensions ?? null };
  }

  async invalidateConditional(requestPath) {
    if (!this.#stateStore) return;
    await this.#stateStore.delete(cacheKey(this.#absoluteUrl(requestPath)));
  }

  async #requestNow(method, requestPath, {
    body = null,
    conditional = false,
    critical = false,
    mutation = null,
  } = {}) {
    this.#rateBudget.assertCanRequest({ critical, now: this.#now() });

    const mutationRequest = mutation == null ? isMutation(method) : mutation === true;
    if (mutationRequest) {
      const waitMs = this.#lastMutationAt + this.#mutationIntervalMs - this.#now();
      if (waitMs > 0) await this.#sleep(waitMs);
    }

    const url = this.#absoluteUrl(requestPath);
    const token = await this.#tokenProvider?.();
    if (!token) throw new HttpError('GitHub authentication token is not available', { status: 0 });

    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': this.#apiVersion,
      'User-Agent': 'DevBridge/0.1'
    };

    const key = conditional && method === 'GET' && this.#stateStore ? cacheKey(url) : null;
    if (key) {
      const cached = await this.#stateStore.get(key);
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      else if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    }

    let payload;
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await this.#fetch(url, { method, headers, body: payload, redirect: 'follow' });
    if (mutationRequest) this.#lastMutationAt = this.#now();
    this.#rateBudget.record(response.headers);

    if (response.status === 304) {
      return { status: 304, data: null, headers: response.headers, notModified: true };
    }

    const text = await response.text();
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (response.status === 403 || response.status === 429) {
      const message = typeof data === 'object' && data?.message ? String(data.message) : String(data ?? '');
      const rateRelated = response.status === 429 || response.headers.get('retry-after') != null || response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message);
      if (rateRelated) {
        throw new RateLimitError(`GitHub rate limit response (${response.status}): ${message || 'retry later'}`, {
          retryAt: RateBudget.retryAtFromResponse(response, this.#now())
        });
      }
    }

    if (!response.ok) {
      throw new HttpError(`GitHub request failed with HTTP ${response.status}`, { status: response.status, body: data });
    }

    if (key) {
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      if (etag || lastModified) await this.#stateStore.set(key, { etag, lastModified });
    }

    return { status: response.status, data, headers: response.headers, notModified: false };
  }
}
