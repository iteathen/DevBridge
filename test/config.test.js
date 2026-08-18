import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function base() {
  return {
    version: 1,
    github: {
      queueRepository: 'iteathen/PATCH-POLLER',
      trustedActorIds: ['1775584'],
      rateLimit: {}
    },
    workspace: {
      root: path.resolve('/tmp/patch-poller-workspace'),
      allowedOwners: ['iteathen']
    },
    state: { directory: path.resolve('/tmp/patch-poller-state') },
    execution: {},
    status: {},
    tools: {}
  };
}

test('uses conservative API and execution defaults', () => {
  const config = validateConfig(base());
  assert.equal(config.github.apiVersion, '2026-03-10');
  assert.equal(config.github.rateLimit.reserveRatio, 0.2);
  assert.equal(config.execution.enabled, false);
  assert.deepEqual(config.workspace.externalReadRoots, []);
});
