import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWindowsGuestImagePayload } from '../src/guest/windows-image-payload.js';

const MEMBERS = [
  'activity-store.mjs',
  'bridge-agent.mjs',
  'environment-bootstrap-agent.mjs',
  'network-seed-agent.mjs',
  'resource-agent.mjs',
  'windows-access-seed-agent.mjs',
  'workspace-agent.mjs',
];

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
