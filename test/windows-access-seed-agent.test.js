import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyWindowsAccessSeed, normalizeWindowsAccessSeed } from '../src/guest/windows-access-seed-agent.mjs';

const SECRET = 'A unique runtime secret 42!';

function seed() {
  return { protocol: 'devbridge/windows-access-seed-v1', target: 'subject-0123456789abcdef0123456789abcdef', user: 'devbridge', secret: SECRET, revision: 1 };
}

test('Windows access seed is exact, bounded, and cannot grant a caller-selected identity', () => {
  assert.deepEqual(normalizeWindowsAccessSeed(seed()), seed());
  assert.throws(() => normalizeWindowsAccessSeed({ ...seed(), user: 'Administrator' }), /user is unsupported/u);
  assert.throws(() => normalizeWindowsAccessSeed({ ...seed(), group: 'Administrators' }), /group is not allowed/u);
  assert.throws(() => normalizeWindowsAccessSeed({ ...seed(), secret: 'short' }), /secret is invalid/u);
});

test('Windows access seed persists digest evidence and deletes transient credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-access-'));
  const seedFile = path.join(root, 'seed.json');
  const stateFile = path.join(root, 'state.json');
  const installs = [];
  try {
    await writeFile(seedFile, `${JSON.stringify(seed())}\n`);
    const first = await applyWindowsAccessSeed({
      seedFile,
      stateFile,
      install: async (value) => { installs.push(value); return { target: value.target, accountIdentity: 'S-1-5-21-1-2-3-1001', standardAccess: true }; },
    });
    assert.deepEqual(first, { changed: true, target: seed().target });
    assert.equal(installs.length, 1);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.protocol, seed().protocol);
    assert.match(state.seedSha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(state).includes(SECRET), false);
    await assert.rejects(() => readFile(seedFile, 'utf8'), /ENOENT/u);

    await writeFile(seedFile, `${JSON.stringify(seed())}\n`);
    assert.deepEqual(await applyWindowsAccessSeed({ seedFile, stateFile, install: async () => { throw new Error('must not reinstall'); } }), { changed: false, target: seed().target });
    await assert.rejects(() => readFile(seedFile, 'utf8'), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows access installer removes elevated membership and never places the secret in argv', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-access-install-'));
  const seedFile = path.join(root, 'seed.json');
  const stateFile = path.join(root, 'state.json');
  const calls = [];
  try {
    await writeFile(seedFile, `${JSON.stringify(seed())}\n`);
    await applyWindowsAccessSeed({
      seedFile,
      stateFile,
      invoke: async (request) => {
        calls.push(request);
        return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"target":"subject-0123456789abcdef0123456789abcdef","accountIdentity":"S-1-5-21-1-2-3-1001","standardAccess":true}', stderr: '' };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments.join(' ').includes(SECRET), false);
    assert.equal(calls[0].input.includes(SECRET), true);
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.match(script, /S-1-5-32-545/u);
    assert.match(script, /S-1-5-32-580/u);
    assert.match(script, /S-1-5-32-544/u);
    assert.match(script, /Administrators membership was not removed/u);
    assert.doesNotMatch(script, /Hyper-V|GitHub|repository|product.?key/iu);
  } finally { await rm(root, { recursive: true, force: true }); }
});
