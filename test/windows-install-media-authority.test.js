import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWindowsInstallMediaAuthority,
  windowsInstallMediaAuthoritySubject,
} from '../src/runtime/image-builders/windows-install-media-authority.js';

function authority(overrides = {}) {
  const sha256 = 'a'.repeat(64);
  return {
    protocol: 'devbridge/windows-install-media-authority-v1',
    media: { name: 'Win11_English_x64.iso', bytes: 7_104_643_072, sha256 },
    approval: {
      sourceClass: 'official-owned',
      expectedSha256: sha256,
      reference: 'https://www.microsoft.com/en-us/software-download/windows11',
      temporary: false,
    },
    image: {
      container: 'wim',
      index: 6,
      name: 'Windows 11 Pro',
      edition: 'Professional',
      architecture: 'amd64',
      version: '10.0.26100.1',
      build: 26100,
      installationType: 'Client',
      languages: ['en-US'],
      defaultLanguage: 'en-US',
    },
    ...overrides,
  };
}

test('Windows install-media authority is immutable, content-addressed, and source-path free', () => {
  const first = authority();
  const reordered = {
    image: first.image,
    approval: first.approval,
    media: first.media,
    protocol: first.protocol,
  };
  const normalized = normalizeWindowsInstallMediaAuthority(first);
  assert.equal(normalized.image.edition, 'Professional');
  assert.deepEqual(normalized.image.languages, ['en-US']);
  assert.equal(normalized.approval.temporary, false);
  assert.match(windowsInstallMediaAuthoritySubject(first), /^subject-[a-f0-9]{32}$/u);
  assert.equal(windowsInstallMediaAuthoritySubject(first), windowsInstallMediaAuthoritySubject(reordered));
  assert.equal(JSON.stringify(normalized).includes('C:\\'), false);
});

test('Windows install-media authority binds the exact source bytes and selected image', () => {
  const first = authority();
  assert.notEqual(
    windowsInstallMediaAuthoritySubject(first),
    windowsInstallMediaAuthoritySubject({ ...first, image: { ...first.image, index: 5, edition: 'Core' } }),
  );
  assert.throws(() => normalizeWindowsInstallMediaAuthority({
    ...first,
    approval: { ...first.approval, expectedSha256: 'b'.repeat(64) },
  }), /approved digest does not match measured media/u);
});

test('Evaluation media is explicit and cannot masquerade as a durable source', () => {
  const first = authority();
  assert.throws(() => normalizeWindowsInstallMediaAuthority({
    ...first,
    approval: {
      sourceClass: 'evaluation',
      expectedSha256: first.media.sha256,
      reference: 'https://www.microsoft.com/en-us/evalcenter/',
      temporary: false,
    },
  }), /evaluation media must be explicitly temporary/u);
  assert.throws(() => normalizeWindowsInstallMediaAuthority({
    ...first,
    approval: { ...first.approval, temporary: true },
  }), /durable media cannot be marked temporary/u);
});

test('Windows install-media authority rejects unofficial provenance and authority leakage', () => {
  const first = authority();
  assert.throws(() => normalizeWindowsInstallMediaAuthority({
    ...first,
    approval: { ...first.approval, reference: 'https://example.com/windows.iso' },
  }), /Microsoft HTTPS source/u);
  assert.throws(() => normalizeWindowsInstallMediaAuthority({ ...first, location: 'C:\\Users\\operator\\Downloads\\windows.iso' }), /location is not allowed/u);
  assert.throws(() => normalizeWindowsInstallMediaAuthority({ ...first, productKey: 'secret' }), /productKey is not allowed/u);
  assert.throws(() => normalizeWindowsInstallMediaAuthority({ ...first, hypervisor: 'hyperv' }), /hypervisor is not allowed/u);
  assert.throws(() => normalizeWindowsInstallMediaAuthority({ ...first, repository: 'owner/project' }), /repository is not allowed/u);
});

test('Organization and enterprise media require a bounded local policy reference', () => {
  const first = authority();
  for (const sourceClass of ['organization-approved', 'enterprise-offline']) {
    const normalized = normalizeWindowsInstallMediaAuthority({
      ...first,
      approval: {
        sourceClass,
        expectedSha256: first.media.sha256,
        reference: 'policy:windows-client-2026',
        temporary: false,
      },
    });
    assert.equal(normalized.approval.sourceClass, sourceClass);
  }
  assert.throws(() => normalizeWindowsInstallMediaAuthority({
    ...first,
    approval: {
      sourceClass: 'organization-approved',
      expectedSha256: first.media.sha256,
      reference: 'C:\\media\\windows.iso',
      temporary: false,
    },
  }), /local policy reference/u);
});
