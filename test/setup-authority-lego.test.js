import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCES = [
  new URL('../src/runtime/setup-authority.js', import.meta.url),
  new URL('../src/state/setup-authority-state-store.js', import.meta.url),
];

const FOREIGN_IDENTITIES = /(?:GitHub|Hyper-V|libvirt|DPAPI|Microsoft|Ubuntu|VHDX|qcow2|product.?key)/iu;
const FOREIGN_IMPORTS = /from\s+['"][^'"]*(?:providers|github|guest|environment-declaration)[^'"]*['"]/iu;

test('setup authority LEGO contains only its neutral local contract', async () => {
  for (const source of SOURCES) {
    const text = await readFile(source, 'utf8');
    assert.doesNotMatch(text, FOREIGN_IDENTITIES);
    assert.doesNotMatch(text, FOREIGN_IMPORTS);
  }
});
