import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentFoundation, ENVIRONMENT_FOUNDATION_STATUS_PROTOCOL, normalizeEnvironmentFoundationStatus } from '../src/runtime/environment-foundation.js';

function capability(ready, reason = null) {
  return { state: ready ? 'ready' : 'unavailable', ready, reason: ready ? null : reason };
}

function fixtures() {
  const images = [{
    identity: 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    profile: 'guest-a',
    generation: '2026-08-19.1',
    retiredAt: null,
    media: { format: 'image', virtualSize: 1024 },
  }];
  const control = {
    async inspect() {
      return {
        identity: '0123456789abcdef0123456789abcdef',
        capabilities: {
          management: capability(true),
          networking: capability(true),
          storage: capability(true),
        },
      };
    },
    async inspectImage() { return { usable: true, format: 'image', parentIdentity: null, virtualSize: 1024 }; },
    async ensureNetwork() { return { ready: true }; },
    async releaseNetwork() { return { released: true }; },
    async ensureStorage() { return { ready: true }; },
    async releaseStorage() { return { released: true }; },
    async reconcile() {},
    async observeInstance(identity) { return { identity, exists: false }; },
    async startInstance(identity) { return { identity, state: 'running' }; },
    async stopInstance(identity) { return { identity, state: 'stopped' }; },
    async removeInstance(identity) { return { identity, removed: true }; },
  };
  const library = {
    async publish(value, { validate }) {
      await validate({ location: '/owned/image' });
      return value;
    },
    async list() { return images; },
    async observe(identity) { return { identity, exists: true, usable: true, location: '/owned/image', entry: images[0] }; },
    async verify(identity) { return { identity, exists: true, usable: true, location: '/owned/image', entry: images[0] }; },
    async inspect() { return capability(true); },
    async retire(identity) { return { identity }; },
    async collect() { return { removed: [] }; },
    async reconcile() {},
  };
  return { control, library };
}

test('foundation status is neutral and composes only local capabilities', async () => {
  const { control, library } = fixtures();
  const foundation = new EnvironmentFoundation({ identity: '0123456789abcdef0123456789abcdef', control, images: library });
  const status = await foundation.inspect();
  assert.equal(status.protocol, ENVIRONMENT_FOUNDATION_STATUS_PROTOCOL);
  assert.equal(status.ready, true);
  assert.deepEqual(Object.keys(status.capabilities).sort(), ['images', 'management', 'networking', 'storage']);
  const serialized = JSON.stringify(status).toLowerCase();
  for (const foreign of ['hyper-v', 'hyperv', 'libvirt', 'qemu', 'powershell', 'virsh', 'repository', 'worker']) {
    assert.equal(serialized.includes(foreign), false);
  }
});

test('foundation accepts transient contracts and rejects context-shaped instance names', async () => {
  const { control, library } = fixtures();
  const foundation = new EnvironmentFoundation({ identity: '0123456789abcdef0123456789abcdef', control, images: library });
  await assert.rejects(() => foundation.observeInstance('owner/project'), /opaque local token/u);
  const opaque = 'abcdefabcdefabcdefabcdefabcdefab';
  assert.deepEqual(await foundation.observeInstance(opaque), { identity: opaque, exists: false, owned: false, state: 'unknown' });
});

test('published media becoming parented degrades image readiness without changing management readiness', async () => {
  const { control, library } = fixtures();
  control.inspectImage = async () => ({ usable: true, format: 'image', parentIdentity: 'present', virtualSize: 1024 });
  const foundation = new EnvironmentFoundation({ identity: '0123456789abcdef0123456789abcdef', control, images: library });
  const status = await foundation.inspect();
  assert.equal(status.capabilities.management.ready, true);
  assert.equal(status.capabilities.images.ready, false);
  assert.equal(status.ready, false);
});


test('status normalization rejects provider-specific fields at the public stud', () => {
  const base = {
    protocol: ENVIRONMENT_FOUNDATION_STATUS_PROTOCOL,
    state: 'ready', ready: true, identity: '0123456789abcdef0123456789abcdef', reason: null,
    capabilities: {
      management: capability(true), images: capability(true), networking: capability(true), storage: capability(true),
    },
  };
  assert.equal(normalizeEnvironmentFoundationStatus(base).ready, true);
  assert.throws(() => normalizeEnvironmentFoundationStatus({ ...base, provider: 'fixture' }), /provider is not allowed/u);
});
