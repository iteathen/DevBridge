import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sources = [
  '../src/app/application-removal.js',
  '../src/app/application-removal/contract.js',
  '../src/app/application-removal/planner.js',
  '../src/app/application-removal/coordinator.js',
];

test('application removal is one isolated module with neutral local contracts', async () => {
  for (const relative of sources) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\.[/\\]/u, relative);
    assert.doesNotMatch(
      source,
      /windows|linux|hyper-v|libvirt|github|repository|provider|\bvm\b|domain|disk|path|setup|runner|permanent-entry|service/iu,
      relative,
    );
  }
});

test('the public stud exposes only its local contract and coordinator', async () => {
  const source = await readFile(new URL('../src/app/application-removal.js', import.meta.url), 'utf8');
  assert.deepEqual(
    source.trim().split(/\r?\n/u),
    [
      "export { APPLICATION_REMOVAL_PROTOCOL } from './application-removal/contract.js';",
      "export { ApplicationRemoval, createApplicationRemoval } from './application-removal/coordinator.js';",
    ],
  );
});
