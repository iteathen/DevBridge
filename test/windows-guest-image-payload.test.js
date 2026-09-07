import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsGuestImagePayload } from '../src/guest/windows-image-payload.js';

const MEMBERS = [
  'activity-store.mjs',
  'bridge-agent.mjs',
  'environment-bootstrap-agent.mjs',
  'local-process.mjs',
  'network-seed-agent.mjs',
  'resource-agent.mjs',
  'transfer-channel.mjs',
  'windows-access-seed-agent.mjs',
  'workspace-agent.mjs',
];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-windows-image-payload-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of MEMBERS) await writeFile(path.join(directory, name), `export default ${JSON.stringify(name)};\n`, 'utf8');
  return directory;
}

test('Windows payload canonicalizes source line endings while preserving exact CRLF generations', async (t) => {
  const directory = await fixture(t);
  const lf = await createWindowsGuestImagePayload({ directory });
  for (const name of MEMBERS) await writeFile(path.join(directory, name), `export default ${JSON.stringify(name)};\r\n`, 'utf8');
  const crlf = await createWindowsGuestImagePayload({ directory });
  assert.deepEqual(lf, crlf);
  const generation = createHash('sha256').update('devbridge/windows-guest-image-payload-v1\0');
  for (const [index, file] of lf.files.entries()) {
    const content = `export default ${JSON.stringify(MEMBERS[index])};\r\n`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const bytes = Buffer.byteLength(content);
    assert.equal(file.content, content);
    assert.equal(file.sha256, sha256);
    assert.equal(file.bytes, bytes);
    generation.update(`${MEMBERS[index]}\0${sha256}\0${bytes}\0`);
  }
  assert.equal(lf.generation, `guest-image-${generation.digest('hex').slice(0, 24)}`);
  await writeFile(path.join(directory, MEMBERS[0]), 'export default "changed";\n');
  assert.notEqual((await createWindowsGuestImagePayload({ directory })).generation, lf.generation);
});

test('Windows payload rejects ambiguous carriage returns and oversized canonical output', async (t) => {
  const directory = await fixture(t);
  const member = path.join(directory, MEMBERS[0]);
  await writeFile(member, 'export default "invalid";\r');
  await assert.rejects(() => createWindowsGuestImagePayload({ directory }), /unsupported line endings/u);
  await writeFile(member, '\n'.repeat(256 * 1024 + 1));
  await assert.rejects(() => createWindowsGuestImagePayload({ directory }), /canonical.*size bound/u);
});

test('Windows guest image payload owns exact platform helpers and neutral target paths', async () => {
  const payload = await createWindowsGuestImagePayload();
  assert.equal(payload.protocol, 'devbridge/windows-guest-image-payload-v1');
  assert.match(payload.generation, /^guest-image-[a-f0-9]{24}$/u);
  assert.deepEqual(payload.files.map((entry) => path.win32.basename(entry.path)), MEMBERS);
  assert.equal(payload.files.every((entry) => entry.path.startsWith('C:\\ProgramData\\DevBridge\\')), true);
  assert.equal(payload.files.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256) && entry.bytes > 0), true);
  assert.equal(payload.files.some((entry) => entry.path.includes('linux-access')), false);
});

test('Windows guest image payload remains isolated from provider and repository topology', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/guest/windows-image-payload.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /HyperV|libvirt|GitHub|repository[A-Z]|product.?key|DPAPI|Codex|CUDA/iu);
});
