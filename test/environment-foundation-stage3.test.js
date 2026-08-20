import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentFoundation } from '../src/runtime/environment-foundation.js';

function ready() { return { state: 'ready', ready: true, reason: null }; }

function fixture() {
  const calls = { collect: [], retire: [], lifecycle: [] };
  const control = {
    async inspect() { return { identity: '0123456789abcdef0123456789abcdef', capabilities: { management: ready(), networking: ready(), storage: ready() } }; },
    async inspectImage() { return { usable: true, format: 'qcow2', contentIdentity: null, parentIdentity: null, virtualSize: 4096 }; },
    async ensureNetwork() { return { ready: true }; }, async releaseNetwork() { return { released: true }; },
    async ensureStorage() { return { ready: true }; }, async releaseStorage() { return { released: true }; }, async reconcile() {},
    async observeInstance(identity) { return { identity, exists: false }; }, async startInstance(identity) { return { identity, exists: true, state: 'running' }; },
    async stopInstance(identity) { return { identity, exists: true, state: 'off' }; }, async removeInstance(identity) { return { identity, removed: true }; },
  };
  const image = { identity: 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profile: 'guest-a', generation: 'r1', retiredAt: null, media: { format: 'qcow2', virtualSize: 4096 } };
  const images = {
    async publish(value) { return value; }, async list() { return [image]; },
    async observe(identity) { return { identity, exists: true, usable: true, location: '/owned/base.qcow2', entry: image }; },
    async verify(identity) { return { identity, exists: true, usable: true, verified: true, location: '/owned/base.qcow2', entry: image }; },
    async inspect() { return ready(); },
    async retire(identity) { calls.retire.push(identity); return { identity }; },
    async collect(options) { calls.collect.push(options); return { removed: [] }; }, async reconcile() {},
  };
  const lifecycle = {
    async ensure(value) { calls.lifecycle.push(['ensure', value]); return { record: { identity: 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }; },
    async list() { return []; }, async observe(identity) { return { identity }; }, async start(identity) { return { identity }; }, async stop(identity) { return { identity }; },
    async reset(identity) { return { identity }; }, async reseed(identity) { return { identity }; }, async remove(identity) { return { identity }; },
    async reconcile() { calls.lifecycle.push(['reconcile']); return []; },
    async protectedSourceIdentities() { return ['img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']; },
  };
  return { control, images, lifecycle, calls };
}

test('Stage 3 lifecycle attaches additively without changing neutral Stage 2 health shape', async () => {
  const { control, images, lifecycle, calls } = fixture();
  const foundation = new EnvironmentFoundation({ identity: '0123456789abcdef0123456789abcdef', control, images, lifecycle });
  const status = await foundation.inspect();
  assert.deepEqual(Object.keys(status.capabilities).sort(), ['images', 'management', 'networking', 'storage']);
  assert.equal(JSON.stringify(status).includes('persistent'), false);
  const request = { subject: 'immutable-42', profile: 'guest-a', sourceIdentity: 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const created = await foundation.ensureEnvironment(request);
  assert.equal(created.record.identity, 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(calls.lifecycle[0], ['ensure', request]);
});

test('image retirement keeps Stage 2 semantics while collection protects active persistent lineage', async () => {
  const { control, images, lifecycle, calls } = fixture();
  const foundation = new EnvironmentFoundation({ identity: '0123456789abcdef0123456789abcdef', control, images, lifecycle });
  await foundation.retireImage('img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(calls.retire, ['img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  await foundation.collectImages({ protectedIdentities: ['img-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] });
  assert.deepEqual(calls.collect[0].protectedIdentities.sort(), ['img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'img-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
});

test('foundation restart reconciliation includes the persistent lifecycle LEGO', async () => {
  const { control, images, lifecycle, calls } = fixture();
  const foundation = new EnvironmentFoundation({ identity: '0123456789abcdef0123456789abcdef', control, images, lifecycle });
  await foundation.reconcile();
  assert.equal(calls.lifecycle.some(([name]) => name === 'reconcile'), true);
});
