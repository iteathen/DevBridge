import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultWindowsToolchainAuthority } from '../src/setup/windows-toolchain-authority.js';
import { WindowsProductionImageAuthorityCatalog } from '../src/runtime/image-builders/windows-production-image-authority-catalog.js';

function authority() {
  const sha256 = 'b'.repeat(64);
  return {
    protocol: 'devbridge/windows-production-image-authority-v1',
    media: { protocol: 'devbridge/windows-install-media-authority-v1', media: { name: 'Windows.iso', bytes: 100, sha256 }, approval: { sourceClass: 'official-owned', expectedSha256: sha256, reference: 'https://www.microsoft.com/en-us/software-download/windows11', temporary: false }, image: { container: 'wim', index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US' } },
    tools: createDefaultWindowsToolchainAuthority(),
    payload: { generation: 'payload-v1' }, recipe: { generation: 'audit-handoff-v1' },
    output: { profile: 'windows-build', generation: 'image-v1', bootstrap: 'payload-v1' },
  };
}

test('Windows production image authority catalog reconciles exact registration without adopting drift', async () => {
  const values = new Map();
  const catalog = new WindowsProductionImageAuthorityCatalog({ store: { async load(key) { return values.get(key); }, async save(key, value) { values.set(key, structuredClone(value)); } } });
  const first = await catalog.register(authority());
  assert.equal(first.created, true);
  assert.deepEqual(await catalog.lookup(first.subjectRef), first.authority);
  assert.equal((await catalog.register(authority())).created, false);
  values.set(first.subjectRef, { ...first.authority, output: { ...first.authority.output, generation: 'image-v2' } });
  await assert.rejects(() => catalog.lookup(first.subjectRef), /identity is corrupt/u);
});
