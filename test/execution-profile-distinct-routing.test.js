import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecutionProfileRouting,
  executionProfileSubject,
} from '../src/app/execution-profile-routing.js';

const ACCESS = Object.freeze({
  family: 'linux',
  user: 'devbridge',
  identityFile: '/host/id',
  knownHostsFile: '/host/known-hosts',
});

function physicalEntry(identity, profile, suffix) {
  return {
    record: {
      identity,
      subject: executionProfileSubject(profile),
      profile,
      generation: 1,
      source: { identity: `img-${suffix.repeat(32)}`, revision: 'v1', digest: suffix.repeat(64) },
      settings: { memoryBytes: 4096, processorCount: 4, firmware: 'efi' },
    },
    observation: {
      identity,
      exists: true,
      owned: true,
      compatible: true,
      state: 'running',
      reason: null,
      storage: null,
    },
  };
}

test('different execution profiles resolve to distinct physical environments', async () => {
  const linuxProfile = 'linux-development';
  const windowsProfile = 'windows-development';
  const linuxIdentity = `env-${'a'.repeat(32)}`;
  const windowsIdentity = `env-${'b'.repeat(32)}`;
  const entries = [
    physicalEntry(linuxIdentity, linuxProfile, 'c'),
    physicalEntry(windowsIdentity, windowsProfile, 'd'),
  ];
  const state = {
    async inspect() { return { ready: true, state: 'ready' }; },
    async listEnvironments() { return structuredClone(entries); },
    async observeEnvironment(target) {
      const entry = entries.find((candidate) => candidate.record.identity === target);
      if (!entry) throw new Error('unknown physical environment');
      return structuredClone(entry);
    },
  };
  const routing = createExecutionProfileRouting({
    state,
    policy: {
      protocol: 'devbridge/environment-execution-routes-v1',
      routes: [
        { subject: '101', profile: linuxProfile, preferred: true, validation: true, access: ACCESS },
        { subject: '202', profile: windowsProfile, preferred: true, validation: false, access: ACCESS },
      ],
    },
  });

  const routed = await routing.listEnvironments();
  const linux = routed.find((entry) => entry.record.subject === '101');
  const windows = routed.find((entry) => entry.record.subject === '202');
  assert.ok(linux);
  assert.ok(windows);
  assert.notEqual(linux.record.identity, windows.record.identity);
  assert.equal(await routing.physicalTarget(linux.record.identity), linuxIdentity);
  assert.equal(await routing.physicalTarget(windows.record.identity), windowsIdentity);
  assert.notEqual(await routing.physicalTarget(linux.record.identity), await routing.physicalTarget(windows.record.identity));
});
