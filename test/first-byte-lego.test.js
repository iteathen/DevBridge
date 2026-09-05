import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const descriptor = readFileSync(new URL('../src/bootstrap/first-byte-release-input.mjs', import.meta.url), 'utf8');
const execution = readFileSync(new URL('../src/bootstrap/first-byte-execution.mjs', import.meta.url), 'utf8');

test('signed first-byte descriptor owns release identity but no source or installation topology', () => {
  assert.doesNotMatch(descriptor, /https?:|origin|offline|filesystem|cache directory|package|snapshot|provider|virtual machine|setup|construct/iu);
});

test('first-byte executor depends on ports and contains no concrete source, package, setup, or provider policy', () => {
  assert.doesNotMatch(execution, /https?:|raw\.github|\boffline\b|source-duration|\bpackages?\b|\bsnapshot\b|\bproviders?\b|virtual machine|\bsetup\b|\bconstruction\b/iu);
  assert.doesNotMatch(execution, /HttpsImmutableObjectSource|FilesystemImmutableObjectSource/u);
});
