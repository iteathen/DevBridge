import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProtectedReadinessObservation,
  PROTECTED_READINESS_OBSERVATION_PROTOCOL,
  PROTECTED_READINESS_RECONCILIATION_PROTOCOL,
  reconcileProtectedReadiness,
} from '../src/setup/protected-readiness-reconciliation.js';

const GENERATION = 'a'.repeat(64);

test('readiness observation is exact, bounded, immutable, and has no compatibility shape', () => {
  const subject = Object.freeze({ local: true });
  const pending = createProtectedReadinessObservation({ ready: false, subject, generation: GENERATION, reason: 'refresh-required' });
  assert.deepEqual(pending, {
    protocol: PROTECTED_READINESS_OBSERVATION_PROTOCOL,
    ready: false,
    subject,
    generation: GENERATION,
    reason: 'refresh-required',
  });
  assert.equal(Object.isFrozen(pending), true);
  assert.deepEqual(createProtectedReadinessObservation({ ready: true, subject: null, generation: GENERATION, reason: null }), {
    protocol: PROTECTED_READINESS_OBSERVATION_PROTOCOL,
    ready: true,
    subject: null,
    generation: GENERATION,
    reason: null,
  });
  assert.throws(() => createProtectedReadinessObservation({ ready: true, subject, generation: GENERATION, reason: null }));
  assert.throws(() => createProtectedReadinessObservation({ ready: false, subject: {}, generation: GENERATION, reason: 'refresh-required' }));
  assert.throws(() => createProtectedReadinessObservation({ ready: false, subject: null, generation: null, reason: 'legacy reason' }));
});

test('already-ready evidence performs no attempt', async () => {
  let attempts = 0;
  const result = await reconcileProtectedReadiness({
    observe: async () => createProtectedReadinessObservation({ ready: true, subject: null, generation: GENERATION, reason: null }),
    attempt: async () => { attempts += 1; },
  });
  assert.deepEqual(result, {
    protocol: PROTECTED_READINESS_RECONCILIATION_PROTOCOL,
    ready: true,
    attempted: false,
    generation: GENERATION,
    reason: null,
  });
  assert.equal(attempts, 0);
});

test('one opaque subject is forwarded unchanged and success comes only from fresh observation', async () => {
  const subject = Object.freeze({ exact: 'opaque' });
  let observations = 0;
  let received = null;
  const result = await reconcileProtectedReadiness({
    observe: async () => {
      observations += 1;
      return observations === 1
        ? createProtectedReadinessObservation({ ready: false, subject, generation: GENERATION, reason: 'refresh-required' })
        : createProtectedReadinessObservation({ ready: true, subject: null, generation: GENERATION, reason: null });
    },
    attempt: async (value) => { received = value; return Object.freeze({ ready: false, foreign: true }); },
  });
  assert.equal(received, subject);
  assert.equal(observations, 2);
  assert.deepEqual(result, {
    protocol: PROTECTED_READINESS_RECONCILIATION_PROTOCOL,
    ready: true,
    attempted: true,
    generation: GENERATION,
    reason: null,
  });
});

test('failed attempt still re-observes once and never retries a second subject', async () => {
  const subjects = [Object.freeze({ sequence: 1 }), Object.freeze({ sequence: 2 })];
  let observations = 0;
  let attempts = 0;
  const result = await reconcileProtectedReadiness({
    observe: async () => createProtectedReadinessObservation({
      ready: false,
      subject: subjects[Math.min(observations++, 1)],
      generation: GENERATION,
      reason: observations === 1 ? 'refresh-required' : 'still-not-ready',
    }),
    attempt: async () => { attempts += 1; throw new Error('claim is not authority'); },
  });
  assert.equal(observations, 2);
  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    protocol: PROTECTED_READINESS_RECONCILIATION_PROTOCOL,
    ready: false,
    attempted: true,
    generation: GENERATION,
    reason: 'still-not-ready',
  });
});

test('missing subject and malformed observations fail without an attempt', async () => {
  let attempts = 0;
  const unavailable = await reconcileProtectedReadiness({
    observe: async () => createProtectedReadinessObservation({ ready: false, subject: null, generation: null, reason: 'observation-unavailable' }),
    attempt: async () => { attempts += 1; },
  });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.attempted, false);
  assert.equal(attempts, 0);

  const malformed = await reconcileProtectedReadiness({
    observe: async () => ({
      ...createProtectedReadinessObservation({ ready: false, subject: Object.freeze({}), generation: GENERATION, reason: 'refresh-required' }),
      legacy: true,
    }),
    attempt: async () => { attempts += 1; },
  });
  assert.equal(malformed.reason, 'observation-invalid');
  assert.equal(attempts, 0);

  let observations = 0;
  const malformedSecond = await reconcileProtectedReadiness({
    observe: async () => {
      observations += 1;
      if (observations === 1) return createProtectedReadinessObservation({ ready: false, subject: Object.freeze({ exact: true }), generation: GENERATION, reason: 'refresh-required' });
      return { ...createProtectedReadinessObservation({ ready: true, subject: null, generation: GENERATION, reason: null }), widened: true };
    },
    attempt: async () => { attempts += 1; },
  });
  assert.equal(malformedSecond.ready, false);
  assert.equal(malformedSecond.attempted, true);
  assert.equal(malformedSecond.reason, 'observation-invalid');
  assert.equal(attempts, 1);
});
