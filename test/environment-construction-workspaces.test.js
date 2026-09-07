import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentConstructionWorkspaces } from '../src/app/environment-construction-workspaces.js';
import { executionProfileSubject, executionWorkspaceIdentity } from '../src/app/execution-profile-routing.js';
import { loadEnvironmentActivityPolicy, publishEnvironmentActivityPolicy } from '../src/runtime/environment-activity-policy.js';
import { createEnvironmentActivityPolicyState } from '../src/runtime/environment-activity-policy-state.js';

function routes(directory) {
  return createEnvironmentActivityPolicyState({ stateDirectory: directory });
}

function stateFor(profile) {
  const physical = {
    record: { identity: 'env-0123456789abcdef0123456789abcdef', subject: executionProfileSubject(profile), profile },
    observation: { exists: true, owned: true, compatible: true },
  };
  return {
    inspect: async () => ({ ready: true }),
    listEnvironments: async () => [structuredClone(physical)],
    observeEnvironment: async () => structuredClone(physical),
  };
}

function channel(events) {
  return {
    health: async (target) => { events.push(['health', target]); return { ready: true }; },
    put: async (target, _source, destination) => { events.push(['put', target, destination]); return { transferred: true }; },
    get: async () => { throw new Error('unexpected get'); },
    execute: async (target, operation) => { events.push(['execute', target, operation]); return { completion: 'observed', result: { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: 'ready', stderr: '' } }; },
  };
}

test('construction workspaces publish exact routes and prepare scoped roots', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    const events = [];
    const port = createEnvironmentConstructionWorkspaces({
      state: stateFor(profile),
      routeState: routes(directory),
      channel: channel(events),
      resolveAuthority: async (authority) => { assert.equal(authority, 'authority-a'); return subject; },
    });
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    const result = await port.ensure(request);
    assert.equal(result.ready, true);
    assert.equal(result.routesChanged, true);
    const policy = await loadEnvironmentActivityPolicy(directory);
    assert.deepEqual(policy.routes, [{
      subject,
      profile,
      preferred: true,
      validation: false,
    }]);
    const scopedPut = events.find((entry) => entry[0] === 'put');
    assert.match(scopedPut[2].path, new RegExp(`^workspaces/${workspace.identity}/lifecycle/ready$`, 'u'));
    const scopedExecute = events.find((entry) => entry[0] === 'execute');
    assert.equal(scopedExecute[2].directory.path, `workspaces/${workspace.identity}`);
    assert.equal((await port.inspect(request)).ready, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('construction workspaces may resolve a request-scoped channel without persisting transport topology', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    let resolved = 0;
    const port = createEnvironmentConstructionWorkspaces({
      state: stateFor(profile),
      routeState: routes(directory),
      resolveChannel: async ({ declaration: selected }) => { assert.equal(selected, declaration); resolved += 1; return channel([]); },
      resolveAuthority: async () => subject,
    });
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    assert.equal((await port.ensure(request)).ready, true);
    assert.equal(resolved, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('construction workspaces refuse identity authority drift', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    const port = createEnvironmentConstructionWorkspaces({
      state: stateFor(profile),
      routeState: routes(directory),
      channel: channel([]),
      resolveAuthority: async () => subject,
    });
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    await port.ensure(request);
    const wrong = { declaration: { ...declaration, workspaces: [{ ...workspace, identity: 'workspace-wrong' }] }, implementationGeneration: request.implementationGeneration };
    await assert.rejects(() => port.ensure(wrong), /does not match host authority/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('adding a second profile preserves the first preference and verifies only the exact new workspace route', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const subject = '42';
    const firstProfile = 'linux-development';
    const nextProfile = 'windows-development';
    const physical = (profile, digit) => ({
      record: { identity: `env-${digit.repeat(32)}`, subject: executionProfileSubject(profile), profile },
      observation: { exists: true, owned: true, compatible: true },
    });
    const entries = [physical(firstProfile, '1'), physical(nextProfile, '2')];
    const state = {
      inspect: async () => ({ ready: true }),
      listEnvironments: async () => structuredClone(entries),
      observeEnvironment: async (identity) => structuredClone(entries.find((entry) => entry.record.identity === identity)),
    };
    const events = [];
    const makePort = () => createEnvironmentConstructionWorkspaces({
      state,
      routeState: routes(directory),
      channel: channel(events),
      resolveAuthority: async () => subject,
    });
    const requestFor = (profile, digit) => {
      const workspaces = [{ identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' }];
      return { declaration: { profile, workspaces }, workspaces, implementationGeneration: `env-${digit.repeat(32)}` };
    };

    await makePort().ensure(requestFor(firstProfile, '1'));
    const firstEventCount = events.length;
    await makePort().ensure(requestFor(nextProfile, '2'));
    assert.deepEqual((await loadEnvironmentActivityPolicy(directory)).routes, [
      { subject, profile: firstProfile, preferred: true, validation: false },
      { subject, profile: nextProfile, preferred: false, validation: false },
    ]);
    const nextEvents = events.slice(firstEventCount).filter((entry) => ['health', 'put', 'execute'].includes(entry[0]));
    assert.ok(nextEvents.length >= 3);
    assert.equal(nextEvents.every((entry) => entry[1] === `env-${'2'.repeat(32)}`), true);
    const nextWorkspace = executionWorkspaceIdentity(subject, nextProfile);
    assert.match(nextEvents.find((entry) => entry[0] === 'put')[2].path, new RegExp(`^workspaces/${nextWorkspace}/`, 'u'));
    assert.equal(nextEvents.find((entry) => entry[0] === 'execute')[2].directory.path, `workspaces/${nextWorkspace}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('expanding a sole non-preferred route promotes it and rejects pre-existing multi-route ambiguity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const subject = '42';
    const profile = 'windows-development';
    await publishEnvironmentActivityPolicy(directory, {
      protocol: 'devbridge/environment-activity-policy-v1',
      routes: [{ subject, profile: 'linux-development', preferred: false, validation: false }],
    });
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    const port = createEnvironmentConstructionWorkspaces({
      state: stateFor(profile),
      routeState: routes(directory),
      channel: channel([]),
      resolveAuthority: async () => subject,
    });
    await port.ensure(request);
    assert.deepEqual((await loadEnvironmentActivityPolicy(directory)).routes, [
      { subject, profile: 'linux-development', preferred: true, validation: false },
      { subject, profile, preferred: false, validation: false },
    ]);

    await publishEnvironmentActivityPolicy(directory, {
      protocol: 'devbridge/environment-activity-policy-v1',
      routes: [
        { subject, profile: 'linux-development', preferred: false, validation: false },
        { subject, profile, preferred: false, validation: false },
      ],
    });
    await assert.rejects(() => port.ensure(request), /no unique preferred profile/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('construction workspaces do not publish admission before scoped-root verification succeeds', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspaces-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    const failing = channel([]);
    failing.execute = async () => ({ completion: 'observed', result: { exitCode: 1, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: 'verification failed' } });
    const port = createEnvironmentConstructionWorkspaces({
      state: stateFor(profile),
      routeState: routes(directory),
      channel: failing,
      resolveAuthority: async () => subject,
    });
    const request = { declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
    await assert.rejects(() => port.ensure(request), /verification failed/u);
    assert.equal(await loadEnvironmentActivityPolicy(directory), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
