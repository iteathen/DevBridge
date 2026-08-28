import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDefaultWindowsToolchainAuthority } from '../src/setup/windows-toolchain-authority.js';
import {
  normalizeWindowsProductionImageAuthority,
  windowsProductionImageAuthoritySubject,
} from '../src/runtime/image-builders/windows-production-image-authority.js';

function authority() {
  const sha256 = 'a'.repeat(64);
  return {
    protocol: 'devbridge/windows-production-image-authority-v1',
    media: {
      protocol: 'devbridge/windows-install-media-authority-v1',
      media: { name: 'Win11_English_x64.iso', bytes: 7_104_643_072, sha256 },
      approval: { sourceClass: 'official-owned', expectedSha256: sha256, reference: 'https://www.microsoft.com/en-us/software-download/windows11', temporary: false },
      image: { container: 'wim', index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US' },
    },
    tools: createDefaultWindowsToolchainAuthority(),
    payload: { generation: 'windows-guest-payload-v1' },
    recipe: { generation: 'audit-handoff-v1' },
    output: { profile: 'windows-build', generation: 'windows-production-v1', bootstrap: 'windows-guest-payload-v1' },
  };
}

test('Windows production image authority binds source, tools, payload, recipe, and output as one immutable subject', () => {
  const first = authority();
  const normalized = normalizeWindowsProductionImageAuthority(first);
  assert.match(windowsProductionImageAuthoritySubject(normalized), /^subject-[a-f0-9]{32}$/u);
  assert.notEqual(windowsProductionImageAuthoritySubject(first), windowsProductionImageAuthoritySubject({ ...first, output: { ...first.output, generation: 'windows-production-v2' } }));
  assert.notEqual(windowsProductionImageAuthoritySubject(first), windowsProductionImageAuthoritySubject({ ...first, payload: { generation: 'windows-guest-payload-v2' } }));
});

test('Windows production image authority rejects paths, secrets, execution, provider, and project topology', async () => {
  const first = authority();
  for (const extra of [
    { sourcePath: 'C:\\media\\windows.iso' },
    { password: 'secret' },
    { command: 'anything' },
    { provider: 'anything' },
    { repository: 'owner/project' },
  ]) assert.throws(() => normalizeWindowsProductionImageAuthority({ ...first, ...extra }), /is not allowed/u);
  const source = await readFile(new URL('../src/runtime/image-builders/windows-production-image-authority.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /HyperV|libvirt|GitHub|repository[A-Z]|product.?key|DPAPI|Codex|CUDA|[A-Z]:\\/iu);
});
