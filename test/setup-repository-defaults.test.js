import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRepositoryDefaults } from '../src/setup/repository-defaults.js';

function repository(index, overrides = {}) {
  return {
    id: index + 1,
    full_name: `owner/repo-${String(index).padStart(2, '0')}`,
    private: false,
    archived: false,
    disabled: false,
    permissions: { push: true },
    ...overrides,
  };
}

test('setup selects every eligible repository when there are at most thirty', () => {
  const result = selectRepositoryDefaults(Array.from({ length: 30 }, (_, index) => repository(index)));
  assert.equal(result.needsSelection, false);
  assert.equal(result.eligibleCount, 30);
  assert.equal(result.selectedCount, 30);
  assert.equal(result.selected.at(-1).fullName, 'owner/repo-29');
});

test('setup stops at thirty-one repositories without truncating discovery', () => {
  const result = selectRepositoryDefaults(Array.from({ length: 31 }, (_, index) => repository(index)));
  assert.equal(result.needsSelection, true);
  assert.equal(result.discoveredCount, 31);
  assert.equal(result.eligibleCount, 31);
  assert.equal(result.selectedCount, 0);
  assert.match(result.reason, /31 eligible repositories/u);
});

test('explicit all selects the complete eligible set above the automatic threshold', () => {
  const result = selectRepositoryDefaults(Array.from({ length: 37 }, (_, index) => repository(index)), { requested: ['all'] });
  assert.equal(result.needsSelection, false);
  assert.equal(result.selectedCount, 37);
});

test('archived disabled and read-only repositories are reported truthfully and excluded', () => {
  const result = selectRepositoryDefaults([
    repository(0),
    repository(1, { archived: true }),
    repository(2, { disabled: true }),
    repository(3, { permissions: { push: false } }),
  ]);
  assert.equal(result.selectedCount, 1);
  assert.deepEqual(result.excluded.map((entry) => entry.reason).sort(), ['archived', 'disabled', 'read-only']);
});

test('explicit selection fails closed when a named repository is not eligible', () => {
  assert.throws(
    () => selectRepositoryDefaults([repository(0), repository(1, { archived: true })], { requested: ['owner/repo-01'] }),
    /not eligible/u,
  );
});
