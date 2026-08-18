import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { GitHubRestClient } from '../src/github/rest-client.js';
import { RateBudget } from '../src/github/rate-budget.js';

function response(body, init) {
  return new Response(body == null ? null : JSON.stringify(body), init);
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
    rateBudget: new RateBudget({ reserveRatio: 0, minimumReserve: 0, emergencyReserve: 0 }),
    fetchImpl
  });

  const first = await client.request('GET', '/repos/a/b/issues', { conditional: true });
  const second = await client.request('GET', '/repos/a/b/issues', { conditional: true });
  assert.equal(first.notModified, false);
  assert.equal(second.notModified, true);
  assert.equal(seen[1]['If-None-Match'], '"abc"');
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
    rateBudget: new RateBudget({ reserveRatio: 0, minimumReserve: 0, emergencyReserve: 0 }),
    fetchImpl
  });
  await Promise.all([client.request('GET', '/a'), client.request('GET', '/b'), client.request('GET', '/c')]);
  assert.equal(maxActive, 1);
});
