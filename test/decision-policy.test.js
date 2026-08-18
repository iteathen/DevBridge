import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDecisionPolicy } from '../src/run/decision-policy.js';

test('decision authority classes come from local configuration with trusted actors only as an explicit default', () => {
  assert.deepEqual(normalizeDecisionPolicy({}, { fallbackActorIds: ['1775584'] }).authorityClasses, { 'security-change': ['1775584'] });
  const custom = normalizeDecisionPolicy({ authorityClasses: { 'security-change': ['1'], architecture: ['2', '2'] }, checkpointTtlMs: 120_000 });
  assert.deepEqual(custom.authorityClasses.architecture, ['2']);
  assert.equal(custom.checkpointTtlMs, 120_000);
  assert.throws(() => normalizeDecisionPolicy({ authorityClasses: { bad: ['remote-name'] } }), /numeric GitHub user IDs/u);
});
