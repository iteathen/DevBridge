import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyFixedLengthMediaPatches } from '../src/runtime/image-builders/fixed-length-media-patcher.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-media-patch-')); }

test('fixed-length patcher replaces exact occurrences including a chunk boundary', async () => {
  const directory = await root();
  try {
    const source = path.join(directory, 'source.iso');
    const destination = path.join(directory, 'derived.iso');
    const before = 'boot quiet ---        ';
    const after = 'boot quiet autoinstall';
    const prefix = 'x'.repeat((64 * 1024) - 7);
    const content = `${prefix}${before} middle${before} tail`;
    await writeFile(source, content);
    const result = await applyFixedLengthMediaPatches({
      source,
      destination,
      chunkBytes: 64 * 1024,
      patches: [{ id: 'boot-entries', before, after, occurrences: 2 }],
    });
    assert.equal(result.applied[0].occurrences, 2);
    assert.equal(result.source.bytes, result.derived.bytes);
    assert.notEqual(result.source.sha256, result.derived.sha256);
    assert.equal(await readFile(destination, 'utf8'), `${prefix}${after} middle${after} tail`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixed-length patcher fails closed and removes a derived file on occurrence drift', async () => {
  const directory = await root();
  try {
    const source = path.join(directory, 'source.iso');
    const destination = path.join(directory, 'derived.iso');
    await writeFile(source, 'one marker only');
    await assert.rejects(() => applyFixedLengthMediaPatches({
      source,
      destination,
      patches: [{ id: 'marker', before: 'marker', after: 'change', occurrences: 2 }],
    }), /expected 2 occurrence/u);
    await assert.rejects(() => stat(destination), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixed-length patcher rejects length changes and overlapping authority', async () => {
  const directory = await root();
  try {
    const source = path.join(directory, 'source.iso');
    await writeFile(source, 'abcdefghijabcdefghij');
    await assert.rejects(() => applyFixedLengthMediaPatches({
      source,
      destination: path.join(directory, 'length.iso'),
      patches: [{ id: 'bad', before: 'abc', after: 'abcd', occurrences: 2 }],
    }), /preserve byte length/u);
    await assert.rejects(() => applyFixedLengthMediaPatches({
      source,
      destination: path.join(directory, 'overlap.iso'),
      patches: [
        { id: 'first', before: 'abcde', after: 'ABCDE', occurrences: 2 },
        { id: 'second', before: 'cdefg', after: 'CDEFG', occurrences: 2 },
      ],
    }), /overlap/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
