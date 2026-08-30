import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const isolated = [
  '../src/runtime/exact-artifact-inventory.js',
  '../src/runtime/exact-value-inventory.js',
  '../src/runtime/exact-value-state.js',
  '../src/runtime/receipt-value-source.js',
  '../src/runtime/exact-action-router.js',
  '../src/runtime/process-activity-lease.js',
  '../src/runtime/bound-effect-actions.js',
];

test('artifact inventory and bound-action components contain no neighboring topology', async () => {
  for (const relative of isolated) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\.?[/\\]/u, relative);
    assert.doesNotMatch(
      source,
      /windows|linux|hyper-v|libvirt|github|repository|provider|\bvm\b|domain|disk|setup|runner|permanent-entry|service|application|purge|payload|authority|managed/iu,
      relative,
    );
  }
});
