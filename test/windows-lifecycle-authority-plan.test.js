import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  bindWindowsLifecycleAuthorityRuntime,
  createWindowsLifecycleAuthorityPlan,
  WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_ACTIVITY_V1,
  WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_CURRENT_V1,
  WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1,
  windowsLifecycleAuthorityRuntimeGeneration,
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_HYPERV_ADMINISTRATORS_SID,
  WINDOWS_NETWORK_CONFIGURATION_OPERATORS_SID,
  WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
  WINDOWS_SYSTEM_SID,
} from '../src/setup/windows-lifecycle-authority.js';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../src/runtime/environment-lifecycle-authority-transport.js';
import {
  environmentActivityAuthorityEndpoint,
  environmentActivityAuthorityIdentity,
} from '../src/runtime/environment-activity-authority-transport.js';
import {
  environmentConfigurationAuthorityEndpoint,
  environmentConfigurationAuthorityIdentity,
} from '../src/runtime/environment-configuration-authority-transport.js';

const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const PROGRAM_DATA = 'C:\\ProgramData';
const OPERATOR_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const PACKAGE_DIGEST = 'a'.repeat(64);
const NODE_DIGEST = 'b'.repeat(64);

function plan(overrides = {}) {
  return createWindowsLifecycleAuthorityPlan({
    stateDirectory: STATE,
    programDataDirectory: PROGRAM_DATA,
    operatorSid: OPERATOR_SID,
    ...overrides,
  });
}

function bound(overrides = {}) {
  return bindWindowsLifecycleAuthorityRuntime(plan(overrides), {
    packageDigest: PACKAGE_DIGEST,
    nodeDigest: NODE_DIGEST,
  });
}

test('Windows authority plan derives one deterministic service and protected generation root from neutral authority identity', () => {
  const value = plan();
  const identity = environmentLifecycleAuthorityIdentity(STATE, { platform: 'win32' });

  assert.equal(value.protocol, WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL);
  assert.equal(value.authorityIdentity, identity);
  assert.equal(value.service.name, `DevBridgeLifecycle-${identity}`);
  assert.equal(value.service.account, `NT SERVICE\\DevBridgeLifecycle-${identity}`);
  assert.equal(value.service.hyperVGroupSid, WINDOWS_HYPERV_ADMINISTRATORS_SID);
  assert.equal(value.service.networkConfigurationGroupSid, WINDOWS_NETWORK_CONFIGURATION_OPERATORS_SID);
  assert.equal(value.protectedRoot, path.win32.join(PROGRAM_DATA, 'DevBridge', 'lifecycle-authority', identity));
  assert.equal(value.authorityDirectory, path.win32.join(value.protectedRoot, 'state'));
  assert.equal(value.runtime.generationsDirectory, path.win32.join(value.protectedRoot, 'generations'));
  assert.equal(value.serviceCommand, null);
  assert.equal(value.runtimeEvidence, null);
});

test('runtime binding places every executable and package byte under one exact content generation', () => {
  const value = bound();
  const generation = windowsLifecycleAuthorityRuntimeGeneration({ packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
  assert.equal(value.runtime.generation, generation);
  assert.equal(value.runtime.generationDirectory, path.win32.join(value.runtime.generationsDirectory, generation));

  for (const target of [
    value.runtime.binDirectory,
    value.runtime.runtimeDirectory,
    value.runtime.packageDirectory,
    value.runtime.serviceHostSource,
    value.runtime.serviceHostExecutable,
    value.runtime.nodeExecutable,
    value.runtime.workerEntry,
  ]) {
    const relative = path.win32.relative(value.runtime.generationDirectory, target);
    assert.notEqual(relative, '');
    assert.equal(relative.startsWith('..'), false, `${target} escaped protected generation`);
    assert.equal(path.win32.isAbsolute(relative), false, `${target} escaped protected generation`);
  }
});

test('Windows authority plan owns the exact generation-addressed SCM command as one closed formula', () => {
  const value = bound();
  assert.match(value.serviceCommand, /^"C:\\ProgramData\\DevBridge\\lifecycle-authority\\[0-9a-f]{32}\\generations\\[0-9a-f]{64}\\bin\\devbridge-lifecycle-authority-host\.exe"/u);
  assert.match(value.serviceCommand, new RegExp(`"--service-name" "${value.service.name}"`, 'u'));
  assert.match(value.serviceCommand, new RegExp(`"--node" "${value.runtime.nodeExecutable.replaceAll('\\', '\\\\')}"`, 'u'));
  assert.match(value.serviceCommand, /"--operator-sid" "S-1-5-21-111111111-222222222-333333333-1001"/u);
  assert.match(value.serviceCommand, new RegExp(`"--read-pipe" "${value.endpoints.read.pipeName}"`, 'u'));
  assert.match(value.serviceCommand, new RegExp(`"--mutation-pipe" "${value.endpoints.mutation.pipeName}"`, 'u'));
  assert.match(value.serviceCommand, new RegExp(`"--acceptance-pipe" "${value.endpoints.acceptance.pipeName}"`, 'u'));
  assert.match(value.serviceCommand, new RegExp(`"--activity-pipe" "${value.endpoints.activity.pipeName}"`, 'u'));
  assert.match(value.serviceCommand, new RegExp(`"--configuration-pipe" "${value.endpoints.configuration.pipeName}"$`, 'u'));
});

test('runtime evidence deterministically binds source freshness without changing service identity', () => {
  const base = plan();
  const first = bindWindowsLifecycleAuthorityRuntime(base, { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
  const second = bindWindowsLifecycleAuthorityRuntime(plan(), { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
  assert.equal(first.authorityIdentity, base.authorityIdentity);
  assert.equal(first.service.name, base.service.name);
  assert.equal(first.service.account, base.service.account);
  assert.deepEqual(first.runtimeEvidence, { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
  assert.equal(first.runtime.generation, second.runtime.generation);
  assert.equal(first.serviceCommand, second.serviceCommand);
  assert.notEqual(first.serviceCommand, base.serviceCommand);
  assert.equal(first.service.description, `DevBridge lifecycle authority runtime v1 package=${PACKAGE_DIGEST} node=${NODE_DIGEST}`);
  assert.throws(() => bindWindowsLifecycleAuthorityRuntime(first, { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST }), /already bound/u);
  assert.throws(() => bindWindowsLifecycleAuthorityRuntime(base, { packageDigest: 'x', nodeDigest: NODE_DIGEST }), /sha256 digest/u);
});

test('host command protocol is explicit and legacy relocation does not invent acceptance capability', () => {
  const current = bound();
  const prior = bindWindowsLifecycleAuthorityRuntime(plan(), {
    packageDigest: PACKAGE_DIGEST,
    nodeDigest: NODE_DIGEST,
    hostCommandProtocol: WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_ACTIVITY_V1,
  });
  const legacy = bindWindowsLifecycleAuthorityRuntime(plan(), {
    packageDigest: PACKAGE_DIGEST,
    nodeDigest: NODE_DIGEST,
    hostCommandProtocol: WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1,
  });
  assert.equal(current.hostCommandProtocol, WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_CURRENT_V1);
  assert.equal(prior.hostCommandProtocol, WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_ACTIVITY_V1);
  assert.equal(legacy.hostCommandProtocol, WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1);
  assert.match(current.serviceCommand, /"--acceptance-pipe"/u);
  assert.match(current.serviceCommand, /"--activity-pipe"/u);
  assert.match(current.serviceCommand, /"--configuration-pipe"/u);
  assert.match(prior.serviceCommand, /"--acceptance-pipe"/u);
  assert.match(prior.serviceCommand, /"--activity-pipe"/u);
  assert.doesNotMatch(prior.serviceCommand, /"--configuration-pipe"/u);
  assert.doesNotMatch(legacy.serviceCommand, /"--acceptance-pipe"/u);
  assert.doesNotMatch(legacy.serviceCommand, /"--activity-pipe"/u);
  assert.doesNotMatch(legacy.serviceCommand, /"--configuration-pipe"/u);
  assert.equal(legacy.runtime.generation, current.runtime.generation);
  assert.throws(() => bindWindowsLifecycleAuthorityRuntime(plan(), {
    packageDigest: PACKAGE_DIGEST,
    nodeDigest: NODE_DIGEST,
    hostCommandProtocol: 'unknown',
  }), /host command protocol/u);
});

test('different runtime evidence cannot alias one protected generation', () => {
  const first = bound();
  const second = bindWindowsLifecycleAuthorityRuntime(plan(), { packageDigest: 'c'.repeat(64), nodeDigest: NODE_DIGEST });
  assert.notEqual(second.runtime.generation, first.runtime.generation);
  assert.notEqual(second.runtime.generationDirectory, first.runtime.generationDirectory);
  assert.notEqual(second.serviceCommand, first.serviceCommand);
  assert.equal(second.service.name, first.service.name);
});

test('Windows authority plan derives five separate neutral capabilities', () => {
  const value = plan();
  assert.equal(value.endpoints.read.endpoint, environmentLifecycleAuthorityEndpoint({
    authorityIdentity: value.authorityIdentity,
    access: 'read',
    platform: 'win32',
  }));
  assert.equal(value.endpoints.mutation.endpoint, environmentLifecycleAuthorityEndpoint({
    authorityIdentity: value.authorityIdentity,
    access: 'mutation',
    platform: 'win32',
  }));
  assert.equal(value.endpoints.acceptance.endpoint, `\\\\.\\pipe\\devbridge-environment-${value.authorityIdentity}-acceptance-v1`);
  const activityIdentity = environmentActivityAuthorityIdentity(STATE, { platform: 'win32' });
  assert.equal(value.endpoints.activity.endpoint, environmentActivityAuthorityEndpoint({ authorityIdentity: activityIdentity, platform: 'win32' }));
  const configurationIdentity = environmentConfigurationAuthorityIdentity(STATE, { platform: 'win32' });
  assert.equal(value.endpoints.configuration.endpoint, environmentConfigurationAuthorityEndpoint({ authorityIdentity: configurationIdentity, platform: 'win32' }));
  assert.match(value.endpoints.read.pipeName, /-read-v1$/u);
  assert.match(value.endpoints.mutation.pipeName, /-mutation-v1$/u);
  assert.match(value.endpoints.acceptance.pipeName, /-acceptance-v1$/u);
  assert.match(value.endpoints.activity.pipeName, /-activity-v1$/u);
  assert.match(value.endpoints.configuration.pipeName, /-configuration-v1$/u);
  assert.notEqual(value.endpoints.acceptance.endpoint, value.endpoints.read.endpoint);
  assert.notEqual(value.endpoints.acceptance.endpoint, value.endpoints.mutation.endpoint);
  assert.notEqual(value.endpoints.activity.endpoint, value.endpoints.read.endpoint);
  assert.notEqual(value.endpoints.activity.endpoint, value.endpoints.mutation.endpoint);
  assert.notEqual(value.endpoints.activity.endpoint, value.endpoints.acceptance.endpoint);
  assert.notEqual(value.endpoints.configuration.endpoint, value.endpoints.read.endpoint);
  assert.notEqual(value.endpoints.configuration.endpoint, value.endpoints.mutation.endpoint);
  assert.notEqual(value.endpoints.configuration.endpoint, value.endpoints.acceptance.endpoint);
  assert.notEqual(value.endpoints.configuration.endpoint, value.endpoints.activity.endpoint);
});

test('ordinary operator can reach read and fixed acceptance capabilities but not persistent mutation capability', () => {
  const value = plan();
  const ordinary = { principal: OPERATOR_SID, rights: 'read-write' };
  const administrators = { principal: WINDOWS_ADMINISTRATORS_SID, rights: 'read-write' };
  assert.deepEqual(value.acl.readPipe.clients, [ordinary, administrators]);
  assert.deepEqual(value.acl.acceptancePipe.clients, [ordinary, administrators]);
  assert.deepEqual(value.acl.activityPipe.clients, [ordinary, administrators]);
  assert.deepEqual(value.acl.configurationPipe.clients, [ordinary, administrators]);
  assert.deepEqual(value.acl.mutationPipe.clients, [administrators]);
  assert.equal(value.acl.mutationPipe.clients.some((entry) => entry.principal === OPERATOR_SID), false);
  for (const selected of [value.acl.readPipe, value.acl.mutationPipe, value.acl.acceptancePipe, value.acl.activityPipe, value.acl.configurationPipe]) {
    assert.equal(selected.clients.some((entry) => entry.rights === 'full-control'), false);
  }
  assert.deepEqual(value.acl.mutationPipe.servers, [
    { principal: value.service.account, rights: 'full-control' },
    { principal: WINDOWS_SYSTEM_SID, rights: 'full-control' },
  ]);
  assert.deepEqual(value.acl.acceptancePipe.servers, value.acl.mutationPipe.servers);
  assert.deepEqual(value.acl.activityPipe.servers, value.acl.mutationPipe.servers);
  assert.deepEqual(value.acl.configurationPipe.servers, value.acl.mutationPipe.servers);
});

test('operator SID does not change protected authority identity or service ownership', () => {
  const first = plan();
  const second = plan({ operatorSid: 'S-1-5-21-111111111-222222222-333333333-2002' });
  assert.equal(second.authorityIdentity, first.authorityIdentity);
  assert.equal(second.protectedRoot, first.protectedRoot);
  assert.deepEqual(second.service, first.service);
  assert.equal(second.serviceCommand, null);
  assert.notDeepEqual(second.acl.readPipe.clients, first.acl.readPipe.clients);
  assert.notDeepEqual(second.acl.acceptancePipe.clients, first.acl.acceptancePipe.clients);
  assert.notDeepEqual(second.acl.activityPipe.clients, first.acl.activityPipe.clients);
  assert.notDeepEqual(second.acl.configurationPipe.clients, first.acl.configurationPipe.clients);
  assert.deepEqual(second.acl.mutationPipe.clients, first.acl.mutationPipe.clients);

  const firstBound = bindWindowsLifecycleAuthorityRuntime(first, { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
  const secondBound = bindWindowsLifecycleAuthorityRuntime(second, { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
  assert.equal(secondBound.runtime.generation, firstBound.runtime.generation);
  assert.notEqual(secondBound.serviceCommand, firstBound.serviceCommand);
});

test('Windows authority plan rejects non-Windows paths, invalid SIDs, and malformed generation evidence', () => {
  assert.throws(() => plan({ stateDirectory: '/tmp/devbridge/state' }), /absolute Windows path/u);
  assert.throws(() => plan({ programDataDirectory: 'ProgramData' }), /absolute Windows path/u);
  assert.throws(() => plan({ operatorSid: 'operator' }), /Windows SID/u);
  assert.throws(() => windowsLifecycleAuthorityRuntimeGeneration({ packageDigest: 'a'.repeat(63), nodeDigest: NODE_DIGEST }), /sha256 digest/u);
});
