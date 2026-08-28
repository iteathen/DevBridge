import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultWindowsToolchainAuthority, normalizeWindowsToolchainAuthority, windowsToolchainAuthoritySubject } from '../src/setup/windows-toolchain-authority.js';

test('Windows toolchain authority is exact, content addressed, and uses primary release sources', () => {
  const authority = createDefaultWindowsToolchainAuthority();
  assert.equal(authority.protocol, 'devbridge/windows-toolchain-authority-v1');
  assert.equal(authority.generation, 'windows-build-basics-20260828-v2');
  assert.equal(authority.artifacts.length, 3);
  assert.deepEqual(authority.artifacts.map((entry) => entry.identity), ['build-tools', 'node', 'source-control']);
  assert.equal(authority.artifacts.every((entry) => /^https:/u.test(entry.uri) && /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.bytes > 0), true);
  assert.match(authority.artifacts.find((entry) => entry.identity === 'node').approval.reference, /SHASUMS256/u);
  assert.match(authority.artifacts.find((entry) => entry.identity === 'source-control').approval.reference, /api\.github\.com/u);
  const nativeBuild = authority.artifacts.find((entry) => entry.identity === 'build-tools');
  assert.equal(nativeBuild.version, '17.14.39');
  assert.equal(nativeBuild.installedVersion, '17.14.37614.0');
  assert.match(nativeBuild.approval.reference, /learn\.microsoft\.com\/en-us\/visualstudio\/releases\/2022\/release-history/u);
  assert.equal(nativeBuild.sha256, '236367b68ba9a51708263ab10a1c85546cc4a8eca78b365168811d19c4fb2f29');
  assert.match(windowsToolchainAuthoritySubject(authority), /^subject-[a-f0-9]{32}$/u);
  assert.deepEqual(normalizeWindowsToolchainAuthority(authority), authority);
});

test('Windows toolchain authority rejects mirrors, mutable aliases, digest drift, and extra execution authority', () => {
  const authority = createDefaultWindowsToolchainAuthority();
  const replace = (identity, changes) => ({ ...authority, artifacts: authority.artifacts.map((entry) => entry.identity === identity ? { ...entry, ...changes } : entry) });
  assert.throws(() => normalizeWindowsToolchainAuthority(replace('node', { uri: 'https://mirror.example/node.msi' })), /uri is not approved/u);
  assert.throws(() => normalizeWindowsToolchainAuthority(replace('build-tools', { uri: 'https://aka.ms/vs/17/release/vs_BuildTools.exe' })), /uri is not approved/u);
  assert.throws(() => normalizeWindowsToolchainAuthority(replace('build-tools', { installedVersion: '17.13.37531.7' })), /installedVersion is invalid/u);
  assert.throws(() => normalizeWindowsToolchainAuthority(replace('node', { installedVersion: '22.23.2' })), /installedVersion is not allowed/u);
  assert.throws(() => normalizeWindowsToolchainAuthority(replace('source-control', { sha256: '0'.repeat(64) })), /approved digest does not match/u);
  assert.throws(() => normalizeWindowsToolchainAuthority({ ...authority, arguments: ['anything'] }), /arguments is not allowed/u);
});

test('Windows toolchain authority remains isolated from provider and project topology', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/setup/windows-toolchain-authority.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /HyperV|libvirt|repository[A-Z]|product.?key|DPAPI|Codex|CUDA/iu);
});
