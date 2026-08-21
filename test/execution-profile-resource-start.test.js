import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionProfileResourceGuard } from '../src/app/environment-foundation.js';

function fixture(state = 'off') {
  const calls = [];
  const current = {
    record: {
      identity: `env-${'a'.repeat(32)}`,
      subject: `profile-${'b'.repeat(32)}`,
      profile: 'linux-development',
      settings: { memoryBytes: 4 * 1024 * 1024 * 1024, processorCount: 4, firmware: 'efi' },
    },
    observation: {
      identity: `env-${'a'.repeat(32)}`,
      exists: true,
      owned: true,
      compatible: true,
      state,
      reason: null,
      storage: null,
    },
  };
  const foundation = {
    async observeEnvironment(identity) {
      calls.push(['observe', identity]);
      return structuredClone(current);
    },
    async startEnvironment(identity) {
      calls.push(['start', identity]);
      return { record: structuredClone(current.record), observation: { ...structuredClone(current.observation), state: 'running' } };
    },
  };
  return { calls, current, foundation };
}

test('stopped profile VM is resource-admitted before provider startup', async () => {
  const { calls, current, foundation } = fixture('off');
  const guarded = createExecutionProfileResourceGuard(foundation, {
    admitMemory(settings) {
      calls.push(['admit', structuredClone(settings)]);
      return { ready: true };
    },
  });

  const result = await guarded.startEnvironment(current.record.identity);
  assert.equal(result.observation.state, 'running');
  assert.deepEqual(calls, [
    ['observe', current.record.identity],
    ['admit', current.record.settings],
    ['start', current.record.identity],
  ]);
});

test('resource admission failure prevents provider startup', async () => {
  const { calls, current, foundation } = fixture('stopped');
  const failure = Object.assign(new Error('insufficient profile resources'), { code: 'PROFILE_RESOURCES_UNAVAILABLE' });
  const guarded = createExecutionProfileResourceGuard(foundation, {
    admitMemory() {
      calls.push(['admit']);
      throw failure;
    },
  });

  await assert.rejects(() => guarded.startEnvironment(current.record.identity), (error) => error === failure);
  assert.deepEqual(calls, [
    ['observe', current.record.identity],
    ['admit'],
  ]);
});

test('already running profile VM does not require a second startup reservation', async () => {
  const { calls, current, foundation } = fixture('running');
  const guarded = createExecutionProfileResourceGuard(foundation, {
    admitMemory() {
      calls.push(['admit']);
    },
  });

  await guarded.startEnvironment(current.record.identity);
  assert.deepEqual(calls, [
    ['observe', current.record.identity],
    ['start', current.record.identity],
  ]);
});
