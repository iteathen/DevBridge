import test from 'node:test';
import assert from 'node:assert/strict';
import { RateBudget } from '../src/github/rate-budget.js';
import { RateLimitError } from '../src/errors.js';

test('protects a proportional shared-account reserve', () => {
  const budget = new RateBudget({ reserveRatio: 0.2, minimumReserve: 250, emergencyReserve: 25 });
  budget.record(new Headers({
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '1000',
    'x-ratelimit-reset': '2000000000'
  }));
  assert.equal(budget.reserveFloor(), 1000);
  assert.throws(() => budget.assertCanRequest({ now: 1_000 }), RateLimitError);
  assert.doesNotThrow(() => budget.assertCanRequest({ critical: true, now: 1_000 }));
});

test('respects X-Poll-Interval observations', () => {
  const budget = new RateBudget();
  budget.record(new Headers({ 'x-poll-interval': '75' }));
  assert.equal(budget.snapshot().pollIntervalMs, 75_000);
});
