import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function base() {
  return {
    version: 1,
    github: { queueRepositories: ['iteathen/DevBridge'], trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.resolve('/tmp/pp-fault-workspace'), allowedOwners: ['iteathen'] },
    state: { directory: path.resolve('/tmp/pp-fault-state') },
    execution: {},
    status: {},
    tools: {},
  };
}

test('fault injection is locally disabled by default', () => {
  const config = validateConfig(base());
  assert.deepEqual(config.execution.faultInjection, { enabled: false, rules: [] });
});

test('local config can enable a bounded named deterministic fault rule', () => {
  const raw = base();
  raw.execution.faultInjection = {
    enabled: true,
    rules: [{ id: 'post-write', point: 'file.after-effect', action: 'interrupt', occurrence: 2 }],
  };
  const config = validateConfig(raw);
  assert.equal(config.execution.faultInjection.enabled, true);
  assert.deepEqual(config.execution.faultInjection.rules[0], {
    id: 'post-write',
    point: 'file.after-effect',
    action: 'interrupt',
    occurrence: 2,
    operation: null,
  });
});

test('local fault config rejects unsupported points, actions, and unbounded occurrences', () => {
  for (const rule of [
    { point: 'remote.shell', action: 'error' },
    { point: 'operation.before', action: 'erase-disk' },
    { point: 'operation.before', action: 'error', occurrence: 1001 },
  ]) {
    const raw = base();
    raw.execution.faultInjection = { enabled: true, rules: [rule] };
    assert.throws(() => validateConfig(raw), /faultInjection/u);
  }
});
