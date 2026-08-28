import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWindowsInstallMediaAuthority,
  windowsInstallMediaAuthoritySubject,
} from '../src/runtime/image-builders/windows-install-media-authority.js';
import { normalizeWindowsInstallMediaInventory } from '../src/runtime/image-sources/windows-install-media-inspector.js';
import { WindowsInstallMediaSelection } from '../src/setup/windows-install-media-selection.js';

function inventory(sha256 = 'a'.repeat(64)) {
  return {
    protocol: 'devbridge/windows-install-media-inventory-v1',
    media: { name: 'Windows.iso', bytes: 100, sha256 },
    images: [
      { container: 'wim', index: 1, name: 'Windows 11 Home', edition: 'Core', architecture: 'amd64', version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US' },
      { container: 'wim', index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US' },
    ],
  };
}

function fixture({ observations = [inventory()], rejected = false } = {}) {
  let persisted = null;
  const authorities = new Map();
  let calls = 0;
  let sourceAvailable = true;
  let inventoryAvailable = !rejected;
  const source = {
    async list() { return [{ reference: 'source-local', name: 'Windows.iso', bytes: 100 }]; },
    async inventory() {
      calls += 1;
      if (!inventoryAvailable) throw new Error('not Windows media');
      return structuredClone(observations[Math.min(calls - 1, observations.length - 1)]);
    },
    async resolve() {
      if (!sourceAvailable) throw new Error('install media source is unavailable');
      return { location: 'C:\\media\\Windows.iso', name: 'Windows.iso', bytes: 100 };
    },
  };
  const catalog = {
    async register(authority) {
      const subjectRef = windowsInstallMediaAuthoritySubject(authority);
      authorities.set(subjectRef, structuredClone(authority));
      return { subjectRef, authority, created: true };
    },
    async lookup(subjectRef) { return structuredClone(authorities.get(subjectRef) ?? null); },
  };
  const state = {
    async load() { return structuredClone(persisted); },
    async save(value) { persisted = structuredClone(value); },
  };
  const createAuthority = ({ media, image, sourceClass, reference, temporary }) => normalizeWindowsInstallMediaAuthority({
    protocol: 'devbridge/windows-install-media-authority-v1',
    media,
    approval: { sourceClass, expectedSha256: media.sha256, reference, temporary },
    image,
  });
  return {
    selection: new WindowsInstallMediaSelection({ source, catalog, state, normalizeInventory: normalizeWindowsInstallMediaInventory, createAuthority }),
    state: () => structuredClone(persisted),
    setState: (value) => { persisted = structuredClone(value); },
    setSourceAvailable: (value) => { sourceAvailable = value; },
    setInventoryAvailable: (value) => { inventoryAvailable = value; },
    registerAuthority: (value) => catalog.register(value),
    calls: () => calls,
  };
}

test('Windows media selection discovers before offering exact path-free choices', async () => {
  const data = fixture();
  const status = await data.selection.discover();
  assert.equal(status.state, 'selection-required');
  assert.equal(status.candidates.length, 1);
  assert.match(status.candidates[0].subject, /^candidate-[a-f0-9]{32}$/u);
  assert.deepEqual(status.candidates[0].images.map((entry) => entry.index), [1, 6]);
  assert.equal(status.acquisition.officialOwned, 'https://www.microsoft.com/en-us/software-download/windows11');
  assert.equal(JSON.stringify(status).includes('C:\\media'), false);
  assert.equal(JSON.stringify(data.state()).includes('C:\\media'), false);
});

test('Windows media approval re-observes the exact candidate and registers immutable authority', async () => {
  const data = fixture();
  const discovered = await data.selection.discover();
  const approved = await data.selection.approve({ candidate: discovered.candidates[0].subject, imageIndex: 6, sourceClass: 'official-owned' });
  assert.equal(data.calls(), 2);
  assert.equal(approved.state, 'accepted');
  assert.equal(approved.accepted.image.edition, 'Professional');
  assert.equal(approved.accepted.temporary, false);
  assert.match(approved.accepted.authority, /^subject-[a-f0-9]{32}$/u);
  const resolved = await data.selection.resolve();
  assert.equal(resolved.location, 'C:\\media\\Windows.iso');
  assert.equal(resolved.authority.approval.reference, 'https://www.microsoft.com/en-us/software-download/windows11');
});

test('Windows media selection refuses source drift and silent Evaluation promotion', async () => {
  const changed = fixture({ observations: [inventory(), inventory('b'.repeat(64))] });
  const discovered = await changed.selection.discover();
  await assert.rejects(
    () => changed.selection.approve({ candidate: discovered.candidates[0].subject, imageIndex: 6, sourceClass: 'official-owned' }),
    /changed after discovery/u,
  );
  assert.equal((await changed.selection.status()).state, 'selection-required');

  const explicit = fixture();
  const candidate = (await explicit.selection.discover()).candidates[0];
  const evaluation = await explicit.selection.approve({ candidate: candidate.subject, imageIndex: 1, sourceClass: 'evaluation' });
  assert.equal(evaluation.accepted.sourceClass, 'evaluation');
  assert.equal(evaluation.accepted.temporary, true);
  assert.equal(evaluation.accepted.image.edition, 'Core');
  await assert.rejects(
    () => explicit.selection.approve({ candidate: candidate.subject, imageIndex: 1, sourceClass: 'temporary' }),
    /sourceClass is invalid/u,
  );
});

test('Windows media discovery isolates unusable candidates without creating authority', async () => {
  const data = fixture({ rejected: true });
  const status = await data.selection.discover();
  assert.equal(status.state, 'source-required');
  assert.equal(status.rejectedCount, 1);
  assert.equal(status.accepted, null);
  assert.equal(await data.selection.resolve(), null);
});

test('Windows media selection rejects malformed persisted inventory before exposing status', async () => {
  const data = fixture();
  await data.selection.discover();
  const persisted = data.state();
  persisted.candidates[0].inventory.media.location = 'C:\\media\\Windows.iso';
  data.setState(persisted);
  await assert.rejects(() => data.selection.status(), /media\.location is not allowed/u);
});

test('Windows media selection does not report accepted after the exact source disappears', async () => {
  const data = fixture();
  const discovered = await data.selection.discover();
  await data.selection.approve({ candidate: discovered.candidates[0].subject, imageIndex: 6, sourceClass: 'official-owned' });
  data.setSourceAvailable(false);
  await assert.rejects(() => data.selection.status(), /source is unavailable/u);
});

test('Windows media selection rejects a valid catalog authority rebound to another candidate', async () => {
  const data = fixture();
  const discovered = await data.selection.discover();
  await data.selection.approve({ candidate: discovered.candidates[0].subject, imageIndex: 6, sourceClass: 'official-owned' });
  const different = inventory('b'.repeat(64));
  const unrelated = normalizeWindowsInstallMediaAuthority({
    protocol: 'devbridge/windows-install-media-authority-v1',
    media: different.media,
    approval: {
      sourceClass: 'official-owned',
      expectedSha256: different.media.sha256,
      reference: 'https://www.microsoft.com/en-us/software-download/windows11',
      temporary: false,
    },
    image: different.images[1],
  });
  const registered = await data.registerAuthority(unrelated);
  const persisted = data.state();
  persisted.accepted.authority = registered.subjectRef;
  data.setState(persisted);
  await assert.rejects(() => data.selection.status(), /does not match its candidate/u);
});

test('Windows media rediscovery clears an accepted selection that is no longer observable', async () => {
  const data = fixture();
  const discovered = await data.selection.discover();
  await data.selection.approve({ candidate: discovered.candidates[0].subject, imageIndex: 6, sourceClass: 'official-owned' });
  data.setInventoryAvailable(false);
  const reconciled = await data.selection.discover();
  assert.equal(reconciled.state, 'source-required');
  assert.equal(reconciled.accepted, null);
  assert.equal(reconciled.rejectedCount, 1);
  assert.equal(data.state().accepted, null);
});
