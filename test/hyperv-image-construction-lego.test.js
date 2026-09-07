import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('../src/runtime/providers/hyperv-image-construction.js', import.meta.url);
const REQUEST = new URL('../src/runtime/providers/hyperv-image-construction/request-contract.js', import.meta.url);

test('Hyper-V image construction remains repository and guest-distribution agnostic', async () => {
  const text = await readFile(SOURCE, 'utf8');
  assert.doesNotMatch(text, /(?:Ubuntu|Canonical|GitHub|repository|workspace|Codex|Aider|CUDA)/iu);
});

test('Hyper-V image construction public request cannot name provider machine or disk targets', async () => {
  const text = await readFile(REQUEST, 'utf8');
  const requestSection = text.slice(text.indexOf('  normalize(raw)'), text.indexOf('  bootSettings('));
  assert.match(requestSection, /dataMedia/u);
  assert.doesNotMatch(requestSection, /(?:vmName|diskPath|configPath|PowerShell|VHDX)/u);
});
