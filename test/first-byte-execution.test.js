import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FirstByteBootstrapExecution } from '../src/bootstrap/first-byte-execution.mjs';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import { immutableObjectSetDigest } from '../src/runtime/immutable-object-set.js';
import { BYTES, HEAD, authority, descriptor, sha256 } from './fixtures/first-byte-fixture.js';

async function root(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'devbridge-first-byte-'));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

function byteSource(bytes, calls, error = null) {
  return {
    async fetch(request) {
      calls.push(request.chunk.sha256);
      if (error) throw error;
      return { body: (async function* () { yield bytes; }()) };
    },
  };
}

test('first-byte execution fails over exact sources and imports only verified bytes', async (t) => {
  const directory = await root(t);
  const primary = [];
  const secondary = [];
  let loaded = 0;
  const acquisition = new ImmutableObjectAcquisition({
    directory: path.join(directory, 'cache'),
    sources: [byteSource(BYTES, primary, new Error('primary down')), byteSource(BYTES, secondary)],
  });
  const execution = new FirstByteBootstrapExecution({
    acquisition,
    async loadModule(bytes) {
      loaded += 1;
      assert.deepEqual(bytes, BYTES);
      return { async runZeroStateBootstrap(argv) { return { status: 0, argv }; } };
    },
  });
  const result = await execution.run({ authority: authority(), argv: ['--install-only', '--ref', HEAD] });
  assert.equal(result.status, 0);
  assert.deepEqual(result.bootstrap.argv, ['--install-only', '--ref', HEAD]);
  assert.equal(result.head, HEAD);
  assert.equal(result.objectSha256, sha256(BYTES));
  assert.equal(loaded, 1);
  assert.equal(primary.length, 1);
  assert.equal(secondary.length, 1);
});

test('first-byte execution completes from offline digest bytes with a blank cache', async (t) => {
  const directory = await root(t);
  const media = path.join(directory, 'media');
  await mkdir(media);
  await writeFile(path.join(media, sha256(BYTES)), BYTES);
  const acquisition = new ImmutableObjectAcquisition({
    directory: path.join(directory, 'cache'),
    sources: [new FilesystemImmutableObjectSource({ directory: media })],
  });
  const execution = new FirstByteBootstrapExecution({
    acquisition,
    async loadModule() { return { async runZeroStateBootstrap() { return { status: 0, offline: true }; } }; },
  });
  const result = await execution.run({ authority: authority(), argv: [] });
  assert.equal(result.bootstrap.offline, true);
  assert.equal(result.status, 0);
});

test('first-byte execution preserves typed unavailability and never invokes the loader', async (t) => {
  const directory = await root(t);
  let loaded = false;
  const acquisition = new ImmutableObjectAcquisition({
    directory: path.join(directory, 'cache'),
    sources: [byteSource(BYTES, [], new Error('down'))],
  });
  const execution = new FirstByteBootstrapExecution({
    acquisition,
    async loadModule() { loaded = true; return {}; },
  });
  await assert.rejects(
    () => execution.run({ authority: authority(), argv: [] }),
    (error) => error?.code === 'IMMUTABLE_OBJECT_UNAVAILABLE' && error?.object === 'bootstrap-devbridge.mjs',
  );
  assert.equal(loaded, false);
});

test('first-byte execution rejects forged acquisition evidence and cache substitution before import', async (t) => {
  const directory = await root(t);
  const object = descriptor().objects[0];
  const wrong = Buffer.from(BYTES);
  wrong[0] ^= 1;
  const location = path.join(directory, 'object');
  await writeFile(location, wrong);
  let loaded = false;
  const execution = new FirstByteBootstrapExecution({
    acquisition: {
      async ensure() {
        return {
          subject: descriptor().subject,
          descriptorSha256: 'f'.repeat(64),
          objects: [{ name: object.name, size: object.size, sha256: object.sha256, location }],
        };
      },
    },
    async loadModule() { loaded = true; return {}; },
  });
  await assert.rejects(() => execution.run({ authority: authority(), argv: [] }), /acquisition descriptor/u);
  assert.equal(loaded, false);

  const correctEvidence = new FirstByteBootstrapExecution({
    acquisition: {
      async ensure(input) {
        return {
          subject: input.descriptor.subject,
          descriptorSha256: immutableObjectSetDigest(input.descriptor),
          objects: [{ name: object.name, size: object.size, sha256: object.sha256, location }],
        };
      },
    },
    async loadModule() { loaded = true; return {}; },
  });
  await assert.rejects(() => correctEvidence.run({ authority: authority(), argv: [] }), /cache object digest/u);
  assert.equal(loaded, false);
});

test('first-byte execution validates the loaded module contract and bootstrap status', async (t) => {
  const directory = await root(t);
  const acquisition = new ImmutableObjectAcquisition({ directory: path.join(directory, 'cache'), sources: [byteSource(BYTES, [])] });
  const missing = new FirstByteBootstrapExecution({ acquisition, async loadModule() { return {}; } });
  await assert.rejects(() => missing.run({ authority: authority(), argv: [] }), /module contract/u);

  const invalid = new FirstByteBootstrapExecution({
    acquisition,
    async loadModule() { return { async runZeroStateBootstrap() { return {}; } }; },
  });
  await assert.rejects(() => invalid.run({ authority: authority(), argv: [] }), /bounded status/u);
});
