import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGuestImagePayload } from '../src/guest/image-payload.js';

const MEMBERS = [
  'bridge-agent.mjs',
  'environment-bootstrap-agent.mjs',
  'linux-access-seed-agent.mjs',
  'network-seed-agent.mjs',
  'resource-agent.mjs',
  'workspace-agent.mjs',
];

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-guest-image-payload-')); }

async function writeFixture(directory, suffix = '') {
  for (const name of MEMBERS) await writeFile(path.join(directory, name), `export default ${JSON.stringify(`${name}${suffix}`)};\n`, 'utf8');
}

test('guest image payload owns the complete neutral guest helper membership and exact bytes', async () => {
  const payload = await createGuestImagePayload();
  assert.match(payload.generation, /^guest-image-[a-f0-9]{24}$/u);
  assert.deepEqual(payload.files.map((entry) => path.basename(entry.path)), MEMBERS);
  assert.equal(payload.files.every((entry) => entry.path.startsWith('/usr/local/libexec/devbridge/')), true);
  assert.equal(payload.files.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.bytes > 0), true);
  assert.equal(payload.files.some((entry) => entry.path.endsWith('/resource-agent.mjs')), true);
  assert.equal(payload.files.some((entry) => entry.path.endsWith('/workspace-agent.mjs')), true);
});

test('guest image payload generation changes when one owned helper changes', async () => {
  const directory = await root();
  try {
    await writeFixture(directory);
    const first = await createGuestImagePayload({ directory });
    await writeFile(path.join(directory, 'resource-agent.mjs'), 'export default "changed";\n', 'utf8');
    const second = await createGuestImagePayload({ directory });
    assert.notEqual(first.generation, second.generation);
    assert.notEqual(first.files.find((entry) => entry.path.endsWith('/resource-agent.mjs')).sha256, second.files.find((entry) => entry.path.endsWith('/resource-agent.mjs')).sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('guest image payload fails closed when its owned membership is incomplete', async () => {
  const directory = await root();
  try {
    await writeFixture(directory);
    await rm(path.join(directory, 'workspace-agent.mjs'));
    await assert.rejects(() => createGuestImagePayload({ directory }), /ENOENT/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
