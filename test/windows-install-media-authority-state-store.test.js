import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { WindowsInstallMediaAuthorityCatalog } from '../src/runtime/image-builders/windows-install-media-authority-catalog.js';
import { createWindowsInstallMediaAuthorityStateStore } from '../src/state/windows-install-media-authority-state-store.js';

function authority() {
  const sha256 = 'c'.repeat(64);
  return {
    protocol: 'devbridge/windows-install-media-authority-v1',
    media: { name: 'windows.iso', bytes: 1024, sha256 },
    approval: {
      sourceClass: 'official-owned', expectedSha256: sha256,
      reference: 'https://www.microsoft.com/en-us/software-download/windows11', temporary: false,
    },
    image: {
      container: 'esd', index: 4, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64',
      version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US',
    },
  };
}

function catalog(file) {
  return new WindowsInstallMediaAuthorityCatalog({ store: createWindowsInstallMediaAuthorityStateStore(file) });
}

test('Windows media authority catalog persists exact subjects and reconciles duplicate registration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-authority-'));
  try {
    const file = path.join(directory, 'authorities.json');
    const first = catalog(file);
    const created = await first.register(authority());
    assert.equal(created.created, true);
    assert.match(created.subjectRef, /^subject-[a-f0-9]{32}$/u);
    assert.equal((await first.register(authority())).created, false);
    const resumed = catalog(file);
    assert.equal((await resumed.lookup(created.subjectRef)).image.build, 26100);
    assert.deepEqual((await resumed.list()).map((entry) => entry.subjectRef), [created.subjectRef]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows media authority catalog rejects content drift under an existing subject', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-authority-drift-'));
  try {
    const file = path.join(directory, 'authorities.json');
    const created = await catalog(file).register(authority());
    const raw = new JsonStateStore(file);
    await raw.set(`authority:${created.subjectRef}`, {
      ...authority(), image: { ...authority().image, build: 26200, version: '10.0.26200.1' },
    });
    await assert.rejects(() => catalog(file).lookup(created.subjectRef), /identity is corrupt/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows media authority catalog accepts only the narrow storage port', () => {
  assert.throws(() => new WindowsInstallMediaAuthorityCatalog({ store: { load() {}, save() {} } }), /store contract is incomplete/u);
});
