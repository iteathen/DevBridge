import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnvironmentOperationSubject, requireEnvironmentOperationSubject } from '../src/runtime/environment-operation-subject.js';

const raw = { environmentIdentity: 'environment-a', operationId: 'operation-a', operation: 'rebuild', declarationRevision: 2, previousImplementationGeneration: 'generation-a', imageIdentity: 'image-b', imageGeneration: 'image-generation-b' };
const request = { environmentIdentity: raw.environmentIdentity, operationId: raw.operationId, declarationRevision: 2, declaration: { image: { identity: raw.imageIdentity, generation: raw.imageGeneration } }, operationSubject: raw };

test('operation subjects are immutable values and bind every consumer authority field', () => {
  const subject = requireEnvironmentOperationSubject(request, 'rebuild');
  assert.ok(Object.isFrozen(subject));
  assert.notEqual(subject, raw);
  assert.deepEqual(subject, raw);
  for (const [key, value] of Object.entries({ environmentIdentity: 'other', operationId: 'other', declarationRevision: 3, operation: 'reset', imageIdentity: 'other', imageGeneration: 'other' })) {
    assert.throws(() => requireEnvironmentOperationSubject({ ...request, operationSubject: { ...raw, [key]: value } }, 'rebuild'), /does not match request authority/u);
  }
});

test('replacement subjects require prior identity and reject extra authority', () => {
  assert.throws(() => normalizeEnvironmentOperationSubject({ ...raw, previousImplementationGeneration: null }), /previous generation is required/u);
  assert.throws(() => normalizeEnvironmentOperationSubject({ ...raw, journal: {} }), /unknown field/u);
  assert.throws(() => normalizeEnvironmentOperationSubject({ ...raw, declarationRevision: 0 }), /revision is invalid/u);
});
