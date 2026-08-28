import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtectedEnvironmentActivity } from '../src/app/environment-activity-host.js';
import { ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL } from '../src/runtime/environment-activity-policy.js';
import { ENVIRONMENT_BRIDGE_PROTOCOL } from '../src/runtime/environment-bridge.js';
import { executionProfileSubject, executionWorkspaceTarget } from '../src/app/execution-profile-routing.js';

const PROFILE = 'linux-development';
const SUBJECT = '42';
const PHYSICAL = `env-${'a'.repeat(32)}`;
const LOGICAL = executionWorkspaceTarget(SUBJECT, PROFILE);

function declaration() {
  return {
    profile: PROFILE,
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
  };
}

test('protected activity composition binds exact environment declarations without projecting access material', async () => {
  const requests = [];
  const exchanges = [];
  const record = {
    record: { identity: PHYSICAL, subject: executionProfileSubject(PROFILE), profile: PROFILE },
    observation: { identity: PHYSICAL, exists: true, owned: true, compatible: true, state: 'running' },
  };
  const selectedDeclaration = declaration();
  const activity = await createProtectedEnvironmentActivity({
    stateDirectory: 'C:\\ordinary',
    authorityDirectory: 'C:\\protected',
    platform: 'win32',
    invoke: async () => { throw new Error('unexpected invocation'); },
    state: {
      inspect: async () => ({ ready: true, identity: 'b'.repeat(32) }),
      listEnvironments: async () => [structuredClone(record)],
      observeEnvironment: async (target) => { assert.equal(target, PHYSICAL); return structuredClone(record); },
    },
    declarations: { list: async () => [{ declaration: selectedDeclaration }] },
    preparation: {
      async ensure(request) { requests.push(request); return { ready: true, implementationGeneration: request.implementationGeneration }; },
      async connection() { throw new Error('injected bridge does not resolve access'); },
    },
    bridgeExchange: async (frame) => {
      exchanges.push(frame);
      return { protocol: ENVIRONMENT_BRIDGE_PROTOCOL, request: frame.request, target: frame.target, kind: frame.kind, ok: true, body: { version: '1.0.0', features: [] } };
    },
    policyLoader: async (directory) => {
      assert.equal(directory, 'C:\\ordinary');
      return { protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: [{ subject: SUBJECT, profile: PROFILE, preferred: true, validation: true }] };
    },
  });

  assert.deepEqual(await activity.prepare(LOGICAL), { generation: PHYSICAL });
  assert.equal(requests[0].implementationGeneration, PHYSICAL);
  assert.equal(requests[0].declaration, selectedDeclaration);
  const result = await activity.exchange({ protocol: ENVIRONMENT_BRIDGE_PROTOCOL, request: '0'.repeat(32), target: LOGICAL, kind: 'health', body: {} });
  assert.equal(exchanges[0].target, PHYSICAL);
  assert.equal(result.target, LOGICAL);
  assert.equal(JSON.stringify({ requests, result }).includes('access'), false);
});

test('protected activity composition refuses missing or ambiguous profile declarations before preparation', async () => {
  const record = {
    record: { identity: PHYSICAL, subject: executionProfileSubject(PROFILE), profile: PROFILE },
    observation: { identity: PHYSICAL, exists: true, owned: true, compatible: true, state: 'running' },
  };
  let ensures = 0;
  const activity = await createProtectedEnvironmentActivity({
    stateDirectory: '/ordinary', authorityDirectory: '/protected', platform: 'linux', invoke: async () => {},
    state: { inspect: async () => ({ ready: true, identity: 'b'.repeat(32) }), listEnvironments: async () => [record], observeEnvironment: async () => record },
    declarations: { list: async () => [] },
    preparation: { ensure: async () => { ensures += 1; }, connection: async () => ({}) },
    bridgeExchange: async () => { throw new Error('unexpected exchange'); },
    policyLoader: async () => ({ protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: [{ subject: SUBJECT, profile: PROFILE }] }),
  });
  await assert.rejects(() => activity.prepare(LOGICAL), /declaration is unavailable or ambiguous/u);
  assert.equal(ensures, 0);
});

test('protected activity can expose fail-closed readiness before workload prerequisites exist', async () => {
  const activity = await createProtectedEnvironmentActivity({
    stateDirectory: '/ordinary', authorityDirectory: '/protected', platform: 'linux', invoke: async () => {},
    state: {
      inspect: async () => ({ ready: false, identity: 'b'.repeat(32), reason: 'no image is published' }),
      listEnvironments: async () => [],
      observeEnvironment: async () => { throw new Error('unavailable'); },
    },
    declarations: { list: async () => [] },
    preparation: { ensure: async () => { throw new Error('unavailable'); }, connection: async () => ({}) },
    bridgeExchange: async () => { throw new Error('unavailable'); },
    policyLoader: async () => ({ protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: [] }),
  });
  assert.deepEqual(await activity.inspect(), { ready: false, identity: 'b'.repeat(32), reason: 'no image is published' });
});
