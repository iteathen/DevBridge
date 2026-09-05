import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEnvironmentProfileSource } from '../src/setup/environment-profile-source.js';

function specification(overrides = {}) {
  return {
    profile: 'profile-a',
    schemaGeneration: 'schema-a',
    guest: { family: 'family-a', generation: 'guest-a' },
    imageGeneration: 'image-generation-a',
    bootstrapGeneration: 'bootstrap-a',
    resources: { memoryBytes: 4096, processorCount: 2 },
    boot: 'boot-a',
    network: 'network-a',
    requirements: ['capability-a'],
    enrollment: 'enrollment-a',
    protectedStateClasses: [],
    ...overrides,
  };
}

function image(overrides = {}) {
  return {
    identity: 'img-0123456789abcdef0123456789abcdef',
    profile: 'profile-a',
    generation: 'image-generation-a',
    retiredAt: null,
    provenance: { bootstrap: 'bootstrap-a' },
    ...overrides,
  };
}

const identify = (authority, profile) => `scope-${authority}-${profile}`;

test('profile source resolves one exact image into isolated workspace declarations', async () => {
  const source = createEnvironmentProfileSource({ specification });
  const result = await source.resolve({ images: [image()], subjects: ['7', '42'], identify });
  assert.equal(result.profile, 'profile-a');
  assert.deepEqual(result.image, { identity: image().identity, generation: 'image-generation-a' });
  assert.deepEqual(result.workspaces, [
    { identity: 'scope-7-profile-a', authority: '7' },
    { identity: 'scope-42-profile-a', authority: '42' },
  ]);
  assert.deepEqual(result.bootstrap, { generation: 'bootstrap-a', requirements: ['capability-a'] });
});

test('profile source returns absent without inventing image authority and retains only exact accepted authority', async () => {
  const source = createEnvironmentProfileSource({ specification });
  assert.equal(await source.resolve({ images: [], subjects: [], identify }), null);
  const retained = await source.resolve({
    images: [],
    subjects: [],
    identify,
    current: { configuration: { declarations: [{
      profile: 'profile-a',
      image: { identity: image().identity, generation: 'image-generation-a' },
      bootstrap: { generation: 'bootstrap-a' },
    }] } },
  });
  assert.equal(retained.image.identity, image().identity);
  await assert.rejects(() => source.resolve({
    images: [], subjects: [], identify,
    current: { configuration: { declarations: [{
      profile: 'profile-a', image: { identity: image().identity, generation: 'obsolete-a' }, bootstrap: { generation: 'bootstrap-a' },
    }] } },
  }), /no longer matches current output authority/u);
});

test('profile source rejects ambiguous generation and bootstrap substitution', async () => {
  const source = createEnvironmentProfileSource({ specification });
  await assert.rejects(
    () => source.resolve({ images: [image(), image({ identity: 'img-abcdef0123456789abcdef0123456789' })], subjects: [], identify }),
    /ambiguous/u,
  );
  await assert.rejects(
    () => source.resolve({ images: [image({ provenance: { bootstrap: 'substituted-a' } })], subjects: [], identify }),
    /bootstrap identity/u,
  );
});

test('profile source primitive contains no platform, provider, or topology identity', async () => {
  const source = await readFile(new URL('../src/setup/environment-profile-source.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /windows|linux|ubuntu|hyper-?v|libvirt|qemu|github|repository|vmname|domainname/iu);
});
