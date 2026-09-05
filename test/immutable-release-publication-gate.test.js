import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  immutableObjectSetDigest,
} from '../src/runtime/immutable-object-set.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import {
  IMMUTABLE_RELEASE_PUBLICATION_PROTOCOL,
  ImmutableReleasePublicationGate,
} from '../src/release/immutable-release-publication-gate.mjs';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function fixture(root) {
  const first = Buffer.from('first immutable release chunk');
  const second = Buffer.from('second immutable release chunk');
  const locations = [path.join(root, 'first'), path.join(root, 'second')];
  await Promise.all([writeFile(locations[0], first), writeFile(locations[1], second)]);
  const chunks = [first, second].map((bytes, ordinal) => ({
    ordinal,
    name: `payload.${String(ordinal).padStart(6, '0')}`,
    offset: ordinal === 0 ? 0 : first.length,
    size: bytes.length,
    sha256: sha256(bytes),
  }));
  const descriptor = {
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: 'publication-gate-test',
    objects: [{
      name: 'payload.bin',
      size: first.length + second.length,
      sha256: sha256(Buffer.concat([first, second])),
      chunks,
    }],
  };
  return {
    descriptor,
    objects: chunks.map((chunk, index) => ({ sha256: chunk.sha256, size: chunk.size, location: locations[index] })),
    prerequisites: [{ name: 'public-key.pem', bytes: Buffer.from('public key') }],
    commit: { name: 'manifest.json', bytes: Buffer.from('signed manifest') },
  };
}

async function destination(root, identity, events, { forge = false, mutateAuthority = false } = {}) {
  const objects = path.join(root, identity, 'objects');
  const authority = path.join(root, identity, 'authority');
  await Promise.all([mkdir(objects, { recursive: true }), mkdir(authority, { recursive: true })]);
  const source = new FilesystemImmutableObjectSource({ directory: objects });
  return {
    identity,
    objects: {
      async ensure(input) {
        events.push(`${identity}:object:${input.sha256}`);
        await copyFile(input.location, path.join(objects, input.sha256));
      },
    },
    source: {
      async fetch(input) {
        events.push(`${identity}:verify:${input.chunk.sha256}`);
        if (forge) {
          return { body: (async function* forgedBody() { yield Buffer.alloc(input.chunk.size); }()) };
        }
        return source.fetch(input);
      },
    },
    authority: {
      async ensure(input) {
        events.push(`${identity}:authority:${input.name}`);
        await writeFile(path.join(authority, input.name), input.bytes, { flag: 'wx' });
        if (mutateAuthority) input.bytes.fill(0);
      },
      async read(input) {
        events.push(`${identity}:read:${input.name}`);
        return readFile(path.join(authority, input.name));
      },
    },
  };
}

test('publication gate verifies every object destination before globally publishing authority last', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-release-publication-'));
  try {
    const release = await fixture(root);
    const events = [];
    const destinations = await Promise.all([
      destination(root, 'origin-a', events, { mutateAuthority: true }),
      destination(root, 'origin-b', events),
    ]);
    const result = await new ImmutableReleasePublicationGate({ destinations }).publish({
      descriptors: [release.descriptor],
      objects: release.objects,
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
    });
    assert.equal(result.protocol, IMMUTABLE_RELEASE_PUBLICATION_PROTOCOL);
    assert.deepEqual(result.descriptorSha256s, [immutableObjectSetDigest(release.descriptor)]);
    assert.deepEqual(result.destinations.map(({ identity }) => identity), ['origin-a', 'origin-b']);
    const firstAuthority = events.findIndex((event) => event.includes(':authority:'));
    const lastVerification = events.reduce((found, event, index) => event.includes(':verify:') ? index : found, -1);
    assert.ok(firstAuthority > lastVerification);
    const firstCommit = events.findIndex((event) => event.endsWith(':authority:manifest.json'));
    const lastPrerequisiteRead = events.reduce((found, event, index) => event.endsWith(':read:public-key.pem') ? index : found, -1);
    assert.ok(firstCommit > lastPrerequisiteRead);
    assert.equal(events.filter((event) => event.endsWith(':authority:manifest.json')).length, 2);
    assert.equal(events.at(-1), 'origin-b:read:manifest.json');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication gate rejects malformed coverage and identity before effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-release-publication-invalid-'));
  try {
    const release = await fixture(root);
    const events = [];
    const first = await destination(root, 'same-origin', events);
    assert.throws(() => new ImmutableReleasePublicationGate({ destinations: [first, first] }), /identities must be unique/u);
    const gate = new ImmutableReleasePublicationGate({ destinations: [first] });
    await assert.rejects(gate.publish({
      descriptors: [release.descriptor],
      objects: release.objects.slice(1),
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
    }), /object coverage/u);
    const changed = structuredClone(release.descriptor);
    changed.objects[0].name = 'changed.bin';
    await assert.rejects(gate.publish({
      descriptors: [release.descriptor, changed],
      objects: release.objects,
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
    }), /descriptors must be unique/u);
    await assert.rejects(gate.publish({
      descriptors: [release.descriptor],
      objects: [...release.objects, release.objects[0]],
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
    }), /object coverage/u);
    await assert.rejects(gate.publish({
      descriptors: [release.descriptor],
      objects: release.objects,
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
      origin: 'https://example.invalid/',
    }), /origin is unsupported/u);
    assert.deepEqual(events, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication gate fails closed before authority commit on forged destination evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-release-publication-forged-'));
  try {
    const release = await fixture(root);
    const events = [];
    const destinations = await Promise.all([
      destination(root, 'origin-a', events),
      destination(root, 'origin-b', events, { forge: true }),
    ]);
    await assert.rejects(new ImmutableReleasePublicationGate({ destinations }).publish({
      descriptors: [release.descriptor],
      objects: release.objects,
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
    }), /object read-back does not match publication/u);
    assert.equal(events.some((event) => event.endsWith(':authority:manifest.json')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication gate rejects authority substitution and pre-aborted work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-release-publication-authority-'));
  try {
    const release = await fixture(root);
    const events = [];
    const target = await destination(root, 'origin-a', events);
    target.authority.read = async (input) => input.name === 'manifest.json' ? Buffer.from('substituted') : Buffer.from('public key');
    await assert.rejects(new ImmutableReleasePublicationGate({ destinations: [target] }).publish({
      descriptors: [release.descriptor],
      objects: release.objects,
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
    }), /authority read-back does not match/u);

    const controller = new AbortController();
    controller.abort(new Error('stop publication'));
    await assert.rejects(new ImmutableReleasePublicationGate({ destinations: [target] }).publish({
      descriptors: [release.descriptor],
      objects: release.objects,
      authorityPrerequisites: release.prerequisites,
      authorityCommit: release.commit,
      signal: controller.signal,
    }), /stop publication/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication gate remains transport and product neutral', async () => {
  const source = await readFile(new URL('../src/release/immutable-release-publication-gate.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['github.com', 'Ubuntu', 'snapshot.ubuntu.com', 'credential', 'Hyper-V', 'libvirt', 'setup --construct', 'Start-VM']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'iu'));
  }
  assert.match(source, /fetchObject/u);
});
