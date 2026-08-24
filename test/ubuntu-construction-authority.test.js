import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUbuntuConstructionAuthority,
  ubuntuConstructionAuthoritySubject,
} from '../src/runtime/image-builders/ubuntu-construction-authority.js';

const SNAPSHOT = '20260823T100000Z';

function authority(overrides = {}) {
  const sourceSha256 = 'a'.repeat(64);
  return {
    protocol: 'devbridge/ubuntu-construction-authority-v1',
    source: {
      protocol: 'devbridge/ubuntu-release-media-v1',
      release: '26.04',
      architecture: 'amd64',
      media: {
        url: 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso',
        name: 'ubuntu-26.04-live-server-amd64.iso',
        sha256: sourceSha256,
        bytes: 3145728000,
      },
      checksums: {
        manifestUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS',
        signatureUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS.gpg',
        signerFingerprint: 'A'.repeat(40),
      },
    },
    recipe: {
      protocol: 'devbridge/ubuntu-autoinstall-recipe-v1',
      sourceSha256,
      generation: 'ubuntu-2604-autoinstall-v1',
      patches: [{ id: 'boot-trigger', occurrences: 2, before: 'install ---', after: 'auto    ---' }],
    },
    packages: {
      generation: 'ubuntu-2604-tools-v1',
      snapshot: SNAPSHOT,
      packages: [
        { name: 'build-essential', version: '12.12ubuntu1' },
        { name: 'cmake', version: '3.31.6-1' },
        { name: 'git', version: '1:2.48.1-0ubuntu1' },
        { name: 'nodejs', version: '22.16.0+dfsg-1' },
        { name: 'npm', version: '10.9.2+ds-1' },
      ],
    },
    payload: { generation: 'guest-image-0123456789abcdef01234567' },
    qualification: { commands: ['make'] },
    output: { profile: 'linux-development', generation: 'ubuntu-2604-production-v1', bootstrap: 'guest-image-v1' },
    ...overrides,
  };
}

test('Ubuntu construction authority is content-addressed and normalizes stable ordering', () => {
  const first = authority();
  const reordered = {
    output: first.output,
    qualification: first.qualification,
    payload: first.payload,
    packages: first.packages,
    recipe: first.recipe,
    source: first.source,
    protocol: first.protocol,
  };
  const normalized = normalizeUbuntuConstructionAuthority(first);
  assert.equal(normalized.source.release, '26.04');
  assert.equal(normalized.packages.snapshot, SNAPSHOT);
  assert.equal(normalized.output.profile, 'linux-development');
  assert.deepEqual(normalized.qualification.commands, ['make']);
  assert.match(ubuntuConstructionAuthoritySubject(first), /^subject-[a-f0-9]{32}$/u);
  assert.equal(ubuntuConstructionAuthoritySubject(first), ubuntuConstructionAuthoritySubject(reordered));
});

test('Ubuntu construction authority binds package archive time into the immutable subject', () => {
  const first = authority();
  const changed = {
    ...first,
    packages: { ...first.packages, snapshot: '20260824T100000Z' },
  };
  assert.notEqual(ubuntuConstructionAuthoritySubject(first), ubuntuConstructionAuthoritySubject(changed));
});

test('Ubuntu construction authority binds media-preparation generation into the immutable subject', () => {
  const first = authority();
  const changed = {
    ...first,
    recipe: { ...first.recipe, generation: 'ubuntu-2604-autoinstall-v2' },
  };
  assert.deepEqual(changed.recipe.patches, first.recipe.patches);
  assert.notEqual(ubuntuConstructionAuthoritySubject(first), ubuntuConstructionAuthoritySubject(changed));
});

test('Ubuntu construction authority binds recipe to exact admitted source bytes', () => {
  assert.throws(() => normalizeUbuntuConstructionAuthority(authority({
    recipe: { ...authority().recipe, sourceSha256: 'b'.repeat(64) },
  })), /recipe source does not match construction media/u);
});

test('Ubuntu construction authority rejects mutable package versions or archive time', () => {
  const base = authority();
  assert.throws(() => normalizeUbuntuConstructionAuthority({
    ...base,
    packages: { generation: 'packages-v1', snapshot: SNAPSHOT, packages: [{ name: 'nodejs', version: 'latest' }] },
  }), /version is invalid/u);
  assert.throws(() => normalizeUbuntuConstructionAuthority({
    ...base,
    packages: { generation: 'packages-v1', packages: [{ name: 'nodejs', version: '22.16.0' }] },
  }), /snapshot is invalid/u);
  assert.throws(() => normalizeUbuntuConstructionAuthority({
    ...base,
    packages: { ...base.packages, snapshot: 'latest' },
  }), /snapshot is invalid/u);
});

test('Ubuntu construction authority rejects unapproved source hosts and extra authority', () => {
  const base = authority();
  assert.throws(() => normalizeUbuntuConstructionAuthority({
    ...base,
    source: { ...base.source, media: { ...base.source.media, url: 'https://example.com/ubuntu.iso' } },
  }), /host is not approved/u);
  assert.throws(() => normalizeUbuntuConstructionAuthority({ ...base, productKey: 'secret' }), /productKey is not allowed/u);
});

test('Ubuntu construction authority rejects caller-selected provider and repository topology', () => {
  const base = authority();
  assert.throws(() => normalizeUbuntuConstructionAuthority({ ...base, hypervisor: 'hyperv' }), /hypervisor is not allowed/u);
  assert.throws(() => normalizeUbuntuConstructionAuthority({ ...base, repository: 'iteathen/DevBridge' }), /repository is not allowed/u);
});
