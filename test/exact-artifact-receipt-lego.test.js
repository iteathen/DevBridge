import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../src/runtime/exact-artifact-receipt.js', import.meta.url);
const LOCAL_IMPORT = /(?:\bfrom\s*|(?:^|\n)\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;

test('exact artifact receipt is import-isolated and names only its local contract', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.deepEqual([...source.matchAll(LOCAL_IMPORT)].map((match) => match[1]), []);
  assert.doesNotMatch(
    source,
    /permanent|wrapper|component|installer|service|setup|github|repository|provider|hyper-v|libvirt|\bvm\b|domain|disk|purge/iu,
  );
  const isolated = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#exact-artifact-receipt`);
  assert.equal(typeof isolated.createExactArtifactReceiptJournal, 'function');
  assert.equal(isolated.EXACT_ARTIFACT_RECEIPT_PROTOCOL, 'devbridge/exact-artifact-receipt-v1');
});
