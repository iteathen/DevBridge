import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { GitHubRestClient } from '../src/github/rest-client.js';
import { RateBudget } from '../src/github/rate-budget.js';
import { HttpError } from '../src/errors.js';

function response(body, init) {
  return new Response(body == null ? null : JSON.stringify(body), init);
}

function budget() {
  return new RateBudget({ reserveRatio: 0, minimumReserve: 0, emergencyReserve: 0 });
}

test('persists ETag and uses it on the next conditional request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-state-'));
  const store = new JsonStateStore(path.join(dir, 'state.json'));
  const seen = [];
  let call = 0;
  const fetchImpl = async (_url, options) => {
    seen.push(options.headers);
    call += 1;
    if (call === 1) return response([{ number: 1 }], { status: 200, headers: { etag: '"abc"', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } });
    return new Response(null, { status: 304, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } });
  };
  const client = new GitHubRestClient({
    tokenProvider: async () => 'token',
    stateStore: store,
    rateBudget: budget(),
    fetchImpl
  });

  const first = await client.request('GET', '/repos/a/b/issues', { conditional: true });
  const second = await client.request('GET', '/repos/a/b/issues', { conditional: true });
  assert.equal(first.notModified, false);
  assert.equal(second.notModified, true);
  assert.equal(seen[1]['If-None-Match'], '"abc"');
});

test('invalidating a conditional request removes the persisted validator', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-state-invalidate-'));
  const store = new JsonStateStore(path.join(dir, 'state.json'));
  const seen = [];
  const fetchImpl = async (_url, options) => {
    seen.push(options.headers);
    return response([], { status: 200, headers: { etag: '"abc"', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } });
  };
  const client = new GitHubRestClient({ tokenProvider: async () => 'token', stateStore: store, rateBudget: budget(), fetchImpl });
  await client.request('GET', '/repos/a/b/issues', { conditional: true });
  await client.invalidateConditional('/repos/a/b/issues');
  await client.request('GET', '/repos/a/b/issues', { conditional: true });
  assert.equal(seen[0]['If-None-Match'], undefined);
  assert.equal(seen[1]['If-None-Match'], undefined);
});

test('GraphQL provenance reads use the serialized rate-budgeted client without mutation throttling', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ data: { nodes: [{ id: 'I_1' }] } }, { status: 200, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } });
  };
  const client = new GitHubRestClient({
    tokenProvider: async () => 'token',
    rateBudget: budget(),
    mutationIntervalMs: 60_000,
    fetchImpl,
    sleepImpl: async () => { throw new Error('GraphQL read must not use mutation throttling'); },
  });
  const result = await client.graphql('query Q($ids: [ID!]!) { nodes(ids: $ids) { id } }', { ids: ['I_1'] });
  assert.deepEqual(result.data.nodes, [{ id: 'I_1' }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/graphql$/u);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body).variables, { ids: ['I_1'] });
});

test('GraphQL error payloads fail closed instead of returning partial authority data', async () => {
  const client = new GitHubRestClient({
    tokenProvider: async () => 'token',
    rateBudget: budget(),
    fetchImpl: async () => response({ data: { nodes: [null] }, errors: [{ message: 'history unavailable' }] }, {
      status: 200,
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' },
    }),
  });
  await assert.rejects(
    () => client.graphql('query { viewer { login } }'),
    (error) => error instanceof HttpError && /GraphQL query returned errors/u.test(error.message),
  );
});

test('serializes concurrent calls', async () => {
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return response({}, { status: 200, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } });
  };
  const client = new GitHubRestClient({
    tokenProvider: async () => 'token',
    rateBudget: budget(),
    fetchImpl
  });
  await Promise.all([client.request('GET', '/a'), client.request('GET', '/b'), client.request('GET', '/c')]);
  assert.equal(maxActive, 1);
});
