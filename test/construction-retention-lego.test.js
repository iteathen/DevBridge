import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('neutral construction retention owner contains no concrete topology or local module dependency', async () => {
  const source = await readFile(new URL('../src/app/construction-retention.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\.?\//u);
  assert.doesNotMatch(source, /ubuntu|windows|hyper-v|vhdx?|iso|github|repository|setup|provider|filesystem|directory|file path/iu);
});
