import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BaseImageLibrary } from '../src/runtime/base-image-library.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-images-'));
  const input = path.join(root, 'source.qcow2');
  await writeFile(input, Buffer.from('immutable image fixture\n'));
  return { root, input, library: new BaseImageLibrary({ directory: path.join(root, 'library') }) };
}

function media(size) {
  return { usable: true, format: 'qcow2', contentIdentity: null, parentIdentity: null, virtualSize: size };
}

test('publishes immutable generations with digest and provenance but no public host path', async () => {
  const { root, input, library } = await fixture();
  try {
    const bytes = await readFile(input);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    const published = await library.publish({
      profile: 'guest-a', generation: '2026-08-19.1', source: input,
      expectedDigest, provenance: { origin: 'operator-import', release: 'fixture-1' },
    }, { validate: async ({ size }) => media(size) });
    assert.match(published.identity, /^img-[a-f0-9]{32}$/u);
    assert.equal(published.digest, expectedDigest);
    assert.equal(published.media.format, 'qcow2');
    const listed = await library.list();
    assert.equal(listed.length, 1);
    assert.equal(Object.hasOwn(listed[0], 'fileName'), false);
    assert.equal(JSON.stringify(listed).includes(path.sep + 'library'), false);
    assert.equal((await library.inspect()).ready, true);
    assert.equal((await library.verify(published.identity)).verified, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generation identity is immutable and a changed payload cannot replace it', async () => {
  const { root, input, library } = await fixture();
  try {
    await library.publish({ profile: 'guest-a', generation: 'stable', source: input, provenance: { origin: 'fixture' } }, { validate: async ({ size }) => media(size) });
    await writeFile(input, Buffer.from('different bytes\n'));
    await assert.rejects(
      () => library.publish({ profile: 'guest-a', generation: 'stable', source: input, provenance: { origin: 'fixture' } }, { validate: async ({ size }) => media(size) }),
      /immutable/u,
    );
    assert.equal((await library.list()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a parented image is rejected before publication', async () => {
  const { root, input, library } = await fixture();
  try {
    await assert.rejects(
      () => library.publish({ profile: 'guest-b', generation: 'g1', source: input, provenance: { origin: 'fixture' } }, {
        validate: async ({ size }) => ({ ...media(size), parentIdentity: 'parented' }),
      }),
      /must not have a parent/u,
    );
    assert.equal((await library.list()).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retired images are retained until explicit collection and protected identities survive collection', async () => {
  const { root, input, library } = await fixture();
  try {
    const published = await library.publish({ profile: 'guest-a', generation: 'g1', source: input, provenance: { origin: 'fixture' } }, { validate: async ({ size }) => media(size) });
    await library.retire(published.identity);
    assert.equal((await library.collect({ protectedIdentities: [published.identity] })).removed.length, 0);
    assert.equal((await library.list()).length, 1);
    assert.deepEqual((await library.collect()).removed, [published.identity]);
    assert.equal((await library.list()).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reconcile completes a durable planned publication after interruption without inventing a new generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-images-reconcile-'));
  const directory = path.join(root, 'library');
  const staging = path.join(directory, 'staging');
  const objects = path.join(directory, 'objects');
  const { mkdir } = await import('node:fs/promises');
  try {
    await mkdir(staging, { recursive: true });
    await mkdir(objects, { recursive: true });
    const payload = Buffer.from('planned image bytes\n');
    const digest = createHash('sha256').update(payload).digest('hex');
    const identity = `img-${createHash('sha256').update(`guest-a\0g1\0${digest}`).digest('hex').slice(0, 32)}`;
    const stagingName = '01234567-89ab-cdef-0123-456789abcdef.staging.qcow2';
    const finalName = `${identity}.qcow2`;
    await writeFile(path.join(staging, stagingName), payload);
    await writeFile(path.join(directory, 'catalog.json'), `${JSON.stringify({
      protocol: 'devbridge/base-image-library-v1', revision: 1, images: {},
      operations: {
        'op-fixture': {
          id: 'op-fixture', state: 'planned', identity, profile: 'guest-a', generation: 'g1',
          digest, size: payload.length, stagingName, finalName,
          media: media(payload.length), provenance: { origin: 'fixture' }, plannedAt: new Date().toISOString(),
        },
      },
    })}\n`);
    const library = new BaseImageLibrary({ directory });
    const status = await library.reconcile();
    assert.equal(status.ready, true);
    const listed = await library.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].identity, identity);
    assert.equal((await library.verify(identity)).verified, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
