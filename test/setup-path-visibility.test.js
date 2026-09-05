import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPathVisibility } from '../src/setup/path-visibility.js';

test('path visibility classifies only the three independent observations', () => {
  assert.equal(classifyPathVisibility({ persisted: false, changed: false, visible: false }), 'not-persisted');
  assert.equal(classifyPathVisibility({ persisted: true, changed: true, visible: false }), 'refresh-required');
  assert.equal(classifyPathVisibility({ persisted: true, changed: false, visible: false }), 'caller-omitted');
  assert.equal(classifyPathVisibility({ persisted: true, changed: false, visible: true }), 'available');
  assert.equal(classifyPathVisibility({ persisted: true, changed: true, visible: true }), 'available');
});

test('path visibility rejects widened or malformed inputs', () => {
  assert.throws(() => classifyPathVisibility(null), /must be an object/u);
  assert.throws(
    () => classifyPathVisibility({ persisted: true, changed: false, visible: false, source: 'foreign' }),
    /unsupported fields/u,
  );
  assert.throws(
    () => classifyPathVisibility({ persisted: true, changed: 0, visible: false }),
    /changed must be boolean/u,
  );
});
