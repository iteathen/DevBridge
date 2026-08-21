import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutionProfileRouting,
  executionProfileSubject,
} from '../src/app/execution-profile-routing.js';

const PROFILE = 'linux-development';
const PHYSICAL = `env-${'a'.repeat(32)}`;
const ACCESS = Object.freeze({ family: 'linux' });

function state() {
  const entry = {
    record: {
      identity: PHYSICAL,
      subject: executionProfileSubject(PROFILE),
      profile: PROFILE,
      generation: 1,
      source: { identity: `img-${'b'.repeat(32)}`, revision: 'v1', digest: 'c'.repeat(64) },
      settings: { memoryBytes: 4096, processorCount: 4, firmware: 'efi' },
    },
    observation: {
      identity: PHYSICAL,
      exists: true,
      owned: true,
      compatible: true,
      state: 'running',
      reason: null,
      storage: null,
    },
  };
  return {
    async inspect() { return { ready: true, state: 'ready' }; },
    async listEnvironments() { return [structuredClone(entry)]; },
    async observeEnvironment(identity) {
      if (identity !== PHYSICAL) throw new Error('unknown physical environment');
      return structuredClone(entry);
    },
  };
}

function routing(subjects) {
  return createExecutionProfileRouting({
    state: state(),
    policy: {
      protocol: 'devbridge/environment-execution-routes-v1',
      routes: subjects.map((subject, index) => ({
        subject,
        profile: PROFILE,
        preferred: true,
        validation: index === 0,
        access: ACCESS,
      })),
    },
  });
}

test('adding and removing repository routes preserves the profile VM and stable workspace target', async () => {
  const initial = routing(['101']);
  const originalTarget = initial.targetForSubject('101');
  assert.equal(await initial.physicalTarget(originalTarget), PHYSICAL);

  const expanded = routing(['101', '202']);
  assert.equal(expanded.targetForSubject('101'), originalTarget);
  assert.equal(await expanded.physicalTarget(originalTarget), PHYSICAL);
  assert.equal(await expanded.physicalTarget(expanded.targetForSubject('202')), PHYSICAL);
  assert.notEqual(expanded.targetForSubject('202'), originalTarget);

  const restarted = routing(['101', '202']);
  assert.equal(restarted.targetForSubject('101'), originalTarget);
  assert.equal(await restarted.physicalTarget(originalTarget), PHYSICAL);

  const reduced = routing(['202']);
  assert.equal(await reduced.physicalTarget(reduced.targetForSubject('202')), PHYSICAL);
});
