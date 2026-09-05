import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  parseUbuntuProductionImageRetentionArguments,
  runUbuntuProductionImageRetentionCommand,
} from '../src/app/ubuntu-production-image-retention-command.js';

const current = 'subject-11111111111111111111111111111111';
const obsolete = 'subject-22222222222222222222222222222222';
const planDigest = 'a'.repeat(64);

function harness() {
  const calls = [];
  const dependencies = {
    environment: {},
    homeDirectory: () => path.resolve('local-retention-home'),
    setupStoreFactory: (location) => ({
      async get(key) {
        calls.push({ operation: 'setup', location, key });
        return { protocol: 'devbridge/setup-status-v1', ubuntu: { snapshot: '20260821T230000Z' } };
      },
    }),
    authorityStoreFactory: (location) => ({
      async list() {
        calls.push({ operation: 'authorities', location });
        return [{ subjectRef: current, value: { stored: true } }];
      },
    }),
    authoritySelector: async (request) => {
      calls.push({ operation: 'select', request });
      return { selected: true };
    },
    subjectFactory: () => current,
    retentionFactory: async (request) => {
      calls.push({ operation: 'compose', request });
      return {
        async inspect() { calls.push({ operation: 'inspect' }); return { protocol: 'plan', digest: planDigest }; },
        async retire(requestToRetire) { calls.push({ operation: 'retire', request: requestToRetire }); return { protocol: 'receipt', complete: true }; },
      };
    },
  };
  return { calls, dependencies };
}

test('construction retention command defaults to read-only local inventory and derives the current subject', async () => {
  const state = harness();
  const result = await runUbuntuProductionImageRetentionCommand([], state.dependencies);
  assert.deepEqual(result, { protocol: 'plan', digest: planDigest });
  assert.deepEqual(state.calls.map((entry) => entry.operation), ['setup', 'authorities', 'select', 'compose', 'inspect']);
  assert.equal(state.calls.find((entry) => entry.operation === 'select').request.snapshot, '20260821T230000Z');
  assert.equal(state.calls.find((entry) => entry.operation === 'compose').request.currentSubject, current);
  assert.equal(
    state.calls.find((entry) => entry.operation === 'compose').request.stateDirectory,
    path.join(path.resolve('local-retention-home'), '.devbridge', 'state'),
  );
  assert.equal(state.calls.some((entry) => entry.operation === 'retire'), false);
});

test('construction retention command forwards only exact subject and current plan confirmation to mutation', async () => {
  const state = harness();
  const result = await runUbuntuProductionImageRetentionCommand(
    ['retire', '--subject', obsolete, '--confirm', planDigest, '--home', path.resolve('selected-retention-home')],
    state.dependencies,
  );
  assert.deepEqual(result, { protocol: 'receipt', complete: true });
  assert.deepEqual(state.calls.find((entry) => entry.operation === 'retire').request, { identity: obsolete, planDigest });
});

test('construction retention command forwards a neutral observer without interpreting it', async () => {
  const state = harness();
  const onProgress = () => {};
  await runUbuntuProductionImageRetentionCommand([], { ...state.dependencies, onProgress });
  assert.equal(state.calls.find((entry) => entry.operation === 'compose').request.onProgress, onProgress);
  await assert.rejects(
    () => runUbuntuProductionImageRetentionCommand([], { ...state.dependencies, onProgress: { write() {} } }),
    /composition is incomplete/u,
  );
});

test('construction retention command rejects implicit, partial, repeated, and inspection mutation authority', () => {
  assert.throws(() => parseUbuntuProductionImageRetentionArguments(['retire', '--subject', obsolete]), /requires exact/u);
  assert.throws(() => parseUbuntuProductionImageRetentionArguments(['inspect', '--subject', obsolete, '--confirm', planDigest]), /does not accept/u);
  assert.throws(() => parseUbuntuProductionImageRetentionArguments(['--home', 'one', '--home', 'two']), /repeated/u);
  assert.throws(() => parseUbuntuProductionImageRetentionArguments(['discard']), /unsupported/u);
});
