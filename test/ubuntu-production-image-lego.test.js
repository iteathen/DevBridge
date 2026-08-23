import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SEED = new URL('../src/runtime/image-builders/ubuntu-production-seed.js', import.meta.url);
const QUALIFICATION = new URL('../src/runtime/image-builders/ubuntu-production-qualification.js', import.meta.url);
const FINALIZATION = new URL('../src/runtime/ssh-image-finalization.js', import.meta.url);

test('Ubuntu seed and qualification do not learn provider, repository, or coding-agent identities', async () => {
  for (const source of [SEED, QUALIFICATION]) {
    const text = await readFile(source, 'utf8');
    assert.doesNotMatch(text, /(?:Hyper-V|HyperV|libvirt|GitHub|repository|workspace|Codex|Aider|CUDA)/u);
  }
});

test('SSH image finalization does not learn guest distribution or provider identities', async () => {
  const text = await readFile(FINALIZATION, 'utf8');
  assert.doesNotMatch(text, /(?:Ubuntu|Canonical|Hyper-V|HyperV|libvirt|GitHub|repository|workspace)/u);
});

test('qualification accepts neutral executable requirements rather than provider-specific fields', async () => {
  const text = await readFile(QUALIFICATION, 'utf8');
  const section = text.slice(text.indexOf('function normalizeExpected'), text.indexOf('function requestId'));
  assert.match(section, /commands/u);
  assert.doesNotMatch(section, /(?:hypervisor|provider|hyperv|guestService)/iu);
});
