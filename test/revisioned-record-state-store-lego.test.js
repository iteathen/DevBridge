import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('revisioned record state owns only neutral local persistence contracts', async () => {
  const source = await readFile(new URL('../src/state/revisioned-record-state-store.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"];?$/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    './exclusive-mutation.js',
    './json-record-file.js',
    'node:path',
    'node:util',
  ]);
  assert.doesNotMatch(
    source,
    /application|removal|uninstall|purge|setup|service|windows|linux|hyper-v|libvirt|github|repository|provider|\bvm\b|domain|disk|path identity/iu,
  );
});
