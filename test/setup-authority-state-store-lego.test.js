import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('state adapter alone composes neutral import-isolated mutation and record-file children', async () => {
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
  const parent = path.join(sourceRoot, 'state', 'setup-authority-state-store.js');
  const childDirectory = path.join(sourceRoot, 'state', 'setup-authority-state-store');
  const children = (await readdir(childDirectory)).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(children, ['exclusive-mutation.js', 'json-record-file.js']);
  const parentText = await readFile(parent, 'utf8');
  assert.doesNotMatch(parentText, /JsonStateStore/u);
  const forbidden = /(?:setup|authority|profile|GitHub|Hyper-V|libvirt|Microsoft|Ubuntu|VHDX|qcow2|repository|remote.?agent|virtual.?machine)/iu;
  for (const name of children) {
    const text = await readFile(path.join(childDirectory, name), 'utf8');
    const imports = [...text.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"];?$/gmu)].map((match) => match[1]);
    assert.equal(imports.every((value) => value.startsWith('node:')), true, name);
    assert.doesNotMatch(text, forbidden, name);
    assert.match(parentText, new RegExp(`from ['\"]\\./setup-authority-state-store/${name.replace('.', '\\.') }['\"]`, 'u'), name);
  }
});
