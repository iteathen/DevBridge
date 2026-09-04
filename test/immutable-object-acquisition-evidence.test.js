import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  immutableObjectSetDigest,
} from '../src/runtime/immutable-object-set.js';
import { reobserveImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition-evidence.js';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function fixture(location, bytes) {
  const digest = sha256(bytes);
  const descriptor = {
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: 'evidence-test',
    objects: [{
      name: 'object.bin',
      size: bytes.length,
      sha256: digest,
      chunks: [{ ordinal: 0, name: 'object.bin.000000', offset: 0, size: bytes.length, sha256: digest }],
    }],
  };
  return {
    descriptor,
    evidence: {
      state: 'cache-committed',
      subject: descriptor.subject,
      descriptorSha256: immutableObjectSetDigest(descriptor),
      objects: [{ name: 'object.bin', size: bytes.length, sha256: digest, location }],
      sourceAttempts: 1,
      reusedChunks: 0,
    },
  };
}

test('acquisition evidence is independently re-observed through a held exact cache file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-immutable-evidence-'));
  try {
    const bytes = Buffer.from('exact cache object');
    const location = path.join(root, 'object');
    await writeFile(location, bytes);
    const value = fixture(location, bytes);
    const observed = await reobserveImmutableObjectAcquisition(value);
    assert.equal(observed.subject, value.descriptor.subject);
    assert.equal(observed.descriptorSha256, immutableObjectSetDigest(value.descriptor));
    assert.deepEqual(observed.objects, [{
      name: 'object.bin', size: bytes.length, sha256: sha256(bytes), location,
    }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('acquisition evidence rejects forged identity, substituted bytes, links, and indirection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-immutable-evidence-invalid-'));
  try {
    const bytes = Buffer.from('exact cache object');
    const location = path.join(root, 'object');
    await writeFile(location, bytes);
    const value = fixture(location, bytes);
    await assert.rejects(reobserveImmutableObjectAcquisition({
      ...value,
      evidence: { ...value.evidence, descriptorSha256: 'f'.repeat(64) },
    }), /descriptor evidence does not match authority/u);

    await writeFile(location, 'substituted');
    await assert.rejects(reobserveImmutableObjectAcquisition(value), /shape does not match authority|digest does not match authority/u);
    await writeFile(location, bytes);

    const linked = path.join(root, 'linked');
    await link(location, linked);
    const linkedValue = fixture(linked, bytes);
    await assert.rejects(reobserveImmutableObjectAcquisition(linkedValue), /unlinked regular file/u);
    await rm(linked);

    const real = path.join(root, 'real');
    const indirect = path.join(root, 'indirect');
    await mkdir(real);
    await writeFile(path.join(real, 'object'), bytes);
    try { await symlink(real, indirect, 'junction'); }
    catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        t.skip('junction creation is unavailable');
        return;
      }
      throw error;
    }
    const indirectValue = fixture(path.join(indirect, 'object'), bytes);
    await assert.rejects(reobserveImmutableObjectAcquisition(indirectValue), /direct nonsymbolic path/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('acquisition evidence cancellation remains bounded and adds no authority fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-immutable-evidence-abort-'));
  try {
    const bytes = Buffer.from('exact cache object');
    const location = path.join(root, 'object');
    await writeFile(location, bytes);
    const value = fixture(location, bytes);
    const controller = new AbortController();
    controller.abort(new Error('stop evidence observation'));
    await assert.rejects(reobserveImmutableObjectAcquisition({ ...value, signal: controller.signal }), /stop evidence observation/u);
    await assert.rejects(reobserveImmutableObjectAcquisition({ ...value, origin: 'https://example.invalid/' }), /origin is unsupported/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
