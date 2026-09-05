import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsEnvironmentProfileSource } from '../src/setup/windows-environment-profile-source.js';
import { WINDOWS_PRODUCTION_OUTPUT } from '../src/setup/windows-production-output.js';

const BOOTSTRAP = 'guest-image-0123456789abcdef01234567';
const IMAGE = 'img-0123456789abcdef0123456789abcdef';

function inventory(overrides = {}) {
  return [{
    identity: IMAGE,
    profile: WINDOWS_PRODUCTION_OUTPUT.profile,
    generation: WINDOWS_PRODUCTION_OUTPUT.generation,
    retiredAt: null,
    provenance: { bootstrap: BOOTSTRAP },
    ...overrides,
  }];
}

test('Windows profile source binds current output, protected boot, resource floor, and neutral capabilities', async () => {
  const source = createWindowsEnvironmentProfileSource({ payloadFactory: async () => ({ generation: BOOTSTRAP }) });
  const declaration = await source.resolve({
    images: inventory(),
    subjects: ['42'],
    identify: (authority, profile) => `scope-${authority}-${profile}`,
  });
  assert.equal(declaration.profile, 'windows-development');
  assert.deepEqual(declaration.guest, { family: 'windows-11', generation: 'windows-11' });
  assert.deepEqual(declaration.image, { identity: IMAGE, generation: 'windows-production-v1' });
  assert.deepEqual(declaration.resources, { memoryBytes: 4_294_967_296, processorCount: 2 });
  assert.deepEqual(declaration.boot, { requirement: 'efi-protected-v1' });
  assert.deepEqual(declaration.network, { requirement: 'managed-egress-v1' });
  assert.deepEqual(declaration.workspaces, [{ identity: 'scope-42-windows-development', authority: '42' }]);
  assert.deepEqual(declaration.bootstrap.requirements, [
    'source-control', 'runtime-js', 'build-config', 'test-runner', 'compiler-c', 'compiler-cxx', 'package-project',
  ]);
});

test('Windows profile source rejects a published image from another current payload generation', async () => {
  const source = createWindowsEnvironmentProfileSource({ payloadFactory: async () => ({ generation: 'guest-image-fedcba9876543210fedcba98' }) });
  await assert.rejects(
    () => source.resolve({ images: inventory(), subjects: [], identify: () => 'scope-a' }),
    /bootstrap identity/u,
  );
});
