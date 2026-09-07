import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsAccessSeedMaterial } from '../src/runtime/windows-access-seed-material.js';

const target = `env-${'a'.repeat(32)}`;
const secret = 'Db!A9-valid-secret-material';

test('Windows access seed material creates one bounded transient and removes only unchanged content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-seed-'));
  try {
    const material = new WindowsAccessSeedMaterial({ directory: root, user: 'devbridge' });
    const prepared = await material.create({ target, user: 'devbridge', secret });
    assert.deepEqual(JSON.parse(await readFile(prepared.file, 'utf8')), {
      protocol: 'devbridge/windows-access-seed-v1', target, user: 'devbridge', secret, revision: 1,
    });
    assert.deepEqual(await prepared.cleanup(), { removed: true });
    assert.deepEqual(await prepared.cleanup(), { removed: false });

    const substituted = await material.create({ target, user: 'devbridge', secret });
    await writeFile(substituted.file, '{}\n', 'utf8');
    await assert.rejects(() => substituted.cleanup(), /identity changed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows access seed material refuses identity, user, and path drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-seed-denial-'));
  try {
    const material = new WindowsAccessSeedMaterial({ directory: root, user: 'devbridge' });
    await assert.rejects(() => material.create({ target: 'profile-value', user: 'devbridge', secret }), /target is invalid/u);
    await assert.rejects(() => material.create({ target, user: 'Administrator', secret }), /user changed/u);
    assert.throws(() => new WindowsAccessSeedMaterial({ directory: 'relative', user: 'devbridge' }), /directory is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows access seed material stays independent from provider and repository topology', async () => {
  const source = await readFile(new URL('../src/runtime/windows-access-seed-material.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /HyperV|libvirt|GitHub|repository[A-Z]|branch|pull request|Codex|CUDA/iu);
});
