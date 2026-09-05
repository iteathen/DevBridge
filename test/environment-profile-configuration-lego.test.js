import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CORE = new URL('../src/runtime/environment-profile-configuration.js', import.meta.url);
const STATE = new URL('../src/state/environment-profile-configuration-state-store.js', import.meta.url);

test('profile configuration core remains isolated from topology and provider identities', async () => {
  const source = await readFile(CORE, 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:app|setup|providers|github|guest)[^'"]*['"]/iu);
  assert.doesNotMatch(source, /\b(?:windows|linux|ubuntu|hyper-v|libvirt|repository|service|pipe|socket|vhdx|qcow2)\b/iu);
});

test('profile configuration persistence owns only its local load and save stud', async () => {
  const source = await readFile(STATE, 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:app|setup|providers|github|guest)[^'"]*['"]/iu);
  assert.doesNotMatch(source, /\b(?:windows|linux|ubuntu|hyper-v|libvirt|repository|service|pipe|socket|vhdx|qcow2)\b/iu);
});
