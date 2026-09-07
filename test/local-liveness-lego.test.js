import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('local liveness owner is import-free and contains no foreign topology identity', async () => {
  const source = await readFile(new URL('../src/app/local-liveness.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import /mu);
  assert.doesNotMatch(source, /ubuntu|windows|hyper-v|vhdx?|iso|github|repository|setup|provider|filesystem|directory|file path|retention/iu);
});
