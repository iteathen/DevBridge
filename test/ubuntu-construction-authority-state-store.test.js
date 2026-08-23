import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { UbuntuConstructionAuthorityCatalog } from '../src/runtime/image-builders/ubuntu-construction-authority-catalog.js';
import { createUbuntuConstructionAuthorityStateStore } from '../src/state/ubuntu-construction-authority-state-store.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-construction-authority-')); }

function authority() {
  const sourceSha256 = 'c'.repeat(64);
  return {
    protocol: 'devbridge/ubuntu-construction-authority-v1',
    source: {
      protocol: 'devbridge/ubuntu-release-media-v1',
      release: '26.04',
      architecture: 'amd64',
      media: { url: 'https://releases.ubuntu.com/26.04/server.iso', name: 'server.iso', sha256: sourceSha256, bytes: 1024 },
      checksums: {
        manifestUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS',
        signatureUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS.gpg',
        signerFingerprint: 'B'.repeat(40),
      },
    },
    recipe: {
      protocol: 'devbridge/ubuntu-autoinstall-recipe-v1', sourceSha256, generation: 'recipe-v1',
      patches: [{ id: 'boot', occurrences: 1, before: 'prompt', after: 'autogo' }],
    },
    packages: { generation: 'packages-v1', packages: [{ name: 'nodejs', version: '22.16.0+dfsg-1' }] },
    payload: { generation: 'guest-image-0123456789abcdef01234567' },
    qualification: { commands: [] },
    output: { profile: 'linux-development', generation: 'ubuntu-production-v1', bootstrap: 'guest-image-v1' },
  };
}

function catalog(file) {
  return new UbuntuConstructionAuthorityCatalog({ store: createUbuntuConstructionAuthorityStateStore(file) });
}

test('construction authority catalog persists immutable content-addressed subjects across restart', async () => {
  const directory = await root();
  try {
    const file = path.join(directory, 'authorities.json');
    const first = catalog(file);
    const created = await first.register(authority());
    assert.equal(created.created, true);
    assert.match(created.subjectRef, /^subject-[a-f0-9]{32}$/u);
    const duplicate = await first.register(authority());
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.subjectRef, created.subjectRef);

    const resumed = catalog(file);
    const loaded = await resumed.lookup(created.subjectRef);
    assert.equal(loaded.output.generation, 'ubuntu-production-v1');
    assert.deepEqual((await resumed.list()).map((entry) => entry.subjectRef), [created.subjectRef]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('construction authority catalog detects content-address drift instead of trusting persistence keys', async () => {
  const directory = await root();
  try {
    const file = path.join(directory, 'authorities.json');
    const first = catalog(file);
    const created = await first.register(authority());
    const raw = new JsonStateStore(file);
    await raw.set(`authority:${created.subjectRef}`, {
      ...authority(),
      output: { ...authority().output, generation: 'different-v2' },
    });
    await assert.rejects(() => catalog(file).lookup(created.subjectRef), /identity is corrupt/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('construction authority catalog accepts only the narrow storage port', () => {
  assert.throws(() => new UbuntuConstructionAuthorityCatalog({ store: { load() {}, save() {} } }), /store contract is incomplete/u);
});
