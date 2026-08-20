import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalExternalDirectory } from '../src/runtime/external-directory.js';

test('external directory policy accepts only a canonical directory outside the excluded root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-external-directory-'));
  const excluded = path.join(root, 'excluded');
  const nested = path.join(excluded, 'nested');
  const external = path.join(root, 'external');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(external)]);
  try {
    await assert.rejects(
      canonicalExternalDirectory(nested, excluded),
      /outside the excluded root/u,
    );
    assert.equal(await canonicalExternalDirectory(external, excluded), await realpath(external));
    assert.equal(await canonicalExternalDirectory(null, excluded), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
