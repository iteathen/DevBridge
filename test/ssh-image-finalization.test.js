import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SshImageFinalization } from '../src/runtime/ssh-image-finalization.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-image-finalize-')); }

async function accessFixture(directory, overrides = {}) {
  const identityFile = path.join(directory, 'identity');
  const knownHostsFile = path.join(directory, 'known_hosts');
  await writeFile(identityFile, 'identity');
  await writeFile(knownHostsFile, 'known');
  return {
    family: 'linux',
    user: 'devbridge',
    address: '192.168.77.23',
    identityFile,
    knownHostsFile,
    ...overrides,
  };
}

test('SSH image finalization exposes only the fixed sanitization action', async () => {
  const directory = await root();
  try {
    const selected = await accessFixture(directory);
    const calls = [];
    const finalizer = new SshImageFinalization({
      executable: 'ssh-test',
      access: async (target) => { assert.equal(target, 'subject-0123456789abcdef0123456789abcdef'); return selected; },
      invoke: async (request) => {
        calls.push(request);
        return { exitCode: 0, stdout: 'devbridge-image-sanitize-v1\n', stderr: '', timedOut: false, aborted: false, outputTruncated: false };
      },
    });
    const result = await finalizer.finalize('subject-0123456789abcdef0123456789abcdef');
    assert.deepEqual(result, { finalized: true, protocol: 'devbridge/image-finalization-v1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'ssh-test');
    assert.equal(calls[0].input, null);
    assert.deepEqual(calls[0].arguments.slice(-3), ['devbridge@192.168.77.23', 'sudo', '/usr/local/libexec/devbridge/image-sanitize.sh']);
    assert.equal(calls[0].arguments.includes('sh'), false);
    assert.equal(calls[0].arguments.includes('-c'), false);
    assert.equal(calls[0].arguments.includes('StrictHostKeyChecking=yes'), true);
    assert.equal(calls[0].arguments.includes('PasswordAuthentication=no'), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SSH image finalization fails closed on access-shape or completion-evidence drift', async () => {
  const directory = await root();
  try {
    const selected = await accessFixture(directory);
    let invoked = 0;
    const badAccess = new SshImageFinalization({
      access: async () => ({ ...selected, provider: 'foreign' }),
      invoke: async () => { invoked += 1; },
    });
    await assert.rejects(() => badAccess.finalize('subject-0123456789abcdef0123456789abcdef'), /provider is not allowed/u);
    assert.equal(invoked, 0);

    const badEvidence = new SshImageFinalization({
      access: async () => selected,
      invoke: async () => ({ exitCode: 0, stdout: 'almost\n', stderr: '', timedOut: false, aborted: false, outputTruncated: false }),
    });
    await assert.rejects(() => badEvidence.finalize('subject-0123456789abcdef0123456789abcdef'), /expected completion evidence/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
