import test from 'node:test';
import assert from 'node:assert/strict';
import { observeBoundedReadiness } from '../src/runtime/bounded-readiness-window.js';

const policy = Object.freeze({
  expectedMilliseconds: 2 * 60 * 1000,
  deadlineMilliseconds: 10 * 60 * 1000,
  recheckMilliseconds: 30 * 1000,
});

test('bounded readiness schedules a neutral observation before its expected frontier', () => {
  const result = observeBoundedReadiness({ ...policy, elapsedMilliseconds: 60_000, observedAt: new Date('2026-08-27T22:01:00.000Z') });
  assert.deepEqual(result, {
    classification: 'observing',
    elapsedMilliseconds: 60_000,
    observedAt: '2026-08-27T22:01:00.000Z',
    startedAt: '2026-08-27T22:00:00.000Z',
    expectedAt: '2026-08-27T22:02:00.000Z',
    hardDeadlineAt: '2026-08-27T22:10:00.000Z',
    nextObservationAt: '2026-08-27T22:01:30.000Z',
  });
});

test('bounded readiness remains resumable between its expected frontier and hard deadline', () => {
  const result = observeBoundedReadiness({ ...policy, elapsedMilliseconds: 9 * 60_000 + 50_000, observedAt: new Date('2026-08-27T22:09:50.000Z') });
  assert.equal(result.classification, 'slow');
  assert.equal(result.nextObservationAt, '2026-08-27T22:10:00.000Z');
});

test('bounded readiness expires without scheduling another observation', () => {
  const result = observeBoundedReadiness({ ...policy, elapsedMilliseconds: 10 * 60_000, observedAt: new Date('2026-08-27T22:10:00.000Z') });
  assert.equal(result.classification, 'expired');
  assert.equal(result.nextObservationAt, null);
});

test('bounded readiness rejects malformed clocks and policy ordering', () => {
  assert.throws(() => observeBoundedReadiness({ ...policy, elapsedMilliseconds: -1, observedAt: new Date() }), /elapsedMilliseconds is invalid/u);
  assert.throws(() => observeBoundedReadiness({ ...policy, elapsedMilliseconds: 0, observedAt: new Date('invalid') }), /clock is invalid/u);
  assert.throws(() => observeBoundedReadiness({ ...policy, elapsedMilliseconds: 0, observedAt: new Date(), expectedMilliseconds: 20, deadlineMilliseconds: 10 }), /policy ordering is invalid/u);
});
