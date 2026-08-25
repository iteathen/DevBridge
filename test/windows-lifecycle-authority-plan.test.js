import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createWindowsLifecycleAuthorityPlan,
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_HYPERV_ADMINISTRATORS_SID,
  WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
  WINDOWS_SYSTEM_SID,
} from '../src/setup/windows-lifecycle-authority.js';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../src/runtime/environment-lifecycle-authority-transport.js';

const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const PROGRAM_DATA = 'C:\\ProgramData';
const OPERATOR_SID = 'S-1-5-21-111111111-222222222-333333333-1001';

function plan(overrides = {}) {
  return createWindowsLifecycleAuthorityPlan({
    stateDirectory: STATE,
    programDataDirectory: PROGRAM_DATA,
    operatorSid: OPERATOR_SID,
    ...overrides,
  });
}

test('Windows authority plan derives one deterministic service and protected root from neutral authority identity', () => {
  const value = plan();
  const identity = environmentLifecycleAuthorityIdentity(STATE, { platform: 'win32' });

  assert.equal(value.protocol, WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL);
  assert.equal(value.authorityIdentity, identity);
  assert.equal(value.service.name, `DevBridgeLifecycle-${identity}`);
  assert.equal(value.service.account, `NT SERVICE\\DevBridgeLifecycle-${identity}`);
  assert.equal(value.service.hyperVGroupSid, WINDOWS_HYPERV_ADMINISTRATORS_SID);
  assert.equal(value.protectedRoot, path.win32.join(PROGRAM_DATA, 'DevBridge', 'lifecycle-authority', identity));
  assert.equal(value.authorityDirectory, path.win32.join(value.protectedRoot, 'state'));

  for (const target of [
    value.authorityDirectory,
    value.runtime.binDirectory,
    value.runtime.runtimeDirectory,
    value.runtime.serviceHostSource,
    value.runtime.serviceHostExecutable,
    value.runtime.nodeExecutable,
    value.runtime.workerEntry,
  ]) {
    const relative = path.win32.relative(value.protectedRoot, target);
    assert.notEqual(relative, '');
    assert.equal(relative.startsWith('..'), false, `${target} escaped protected root`);
    assert.equal(path.win32.isAbsolute(relative), false, `${target} escaped protected root`);
  }
});

test('Windows authority plan owns the exact SCM command as one closed formula', () => {
  const value = plan();
  assert.match(value.serviceCommand, /^"C:\\ProgramData\\DevBridge\\lifecycle-authority\\[0-9a-f]{32}\\bin\\devbridge-lifecycle-authority-host\.exe"/u);
  assert.match(value.serviceCommand, new RegExp(`"--service-name" "${value.service.name}"`, 'u'));
  assert.match(value.serviceCommand, /"--operator-sid" "S-1-5-21-111111111-222222222-333333333-1001"/u);
  assert.match(value.serviceCommand, new RegExp(`"--read-pipe" "${value.endpoints.read.pipeName}"`, 'u'));
  assert.match(value.serviceCommand, new RegExp(`"--mutation-pipe" "${value.endpoints.mutation.pipeName}"$`, 'u'));
});

test('Windows authority plan preserves existing neutral endpoint namespace', () => {
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
  assert.match(value.endpoints.read.pipeName, /-read-v1$/u);
  assert.match(value.endpoints.mutation.pipeName, /-mutation-v1$/u);
});

test('ordinary operator is admitted to read capability but not persistent mutation capability', () => {
  const value = plan();
  assert.deepEqual(value.acl.readPipe.clients, [
    { principal: OPERATOR_SID, rights: 'read-write' },
    { principal: WINDOWS_ADMINISTRATORS_SID, rights: 'read-write' },
  ]);
  assert.deepEqual(value.acl.mutationPipe.clients, [
    { principal: WINDOWS_ADMINISTRATORS_SID, rights: 'read-write' },
  ]);
  assert.equal(value.acl.mutationPipe.clients.some((entry) => entry.principal === OPERATOR_SID), false);
  assert.equal(value.acl.readPipe.clients.some((entry) => entry.rights === 'full-control'), false);
  assert.equal(value.acl.mutationPipe.clients.some((entry) => entry.rights === 'full-control'), false);
  assert.deepEqual(value.acl.mutationPipe.servers, [
    { principal: value.service.account, rights: 'full-control' },
    { principal: WINDOWS_SYSTEM_SID, rights: 'full-control' },
  ]);
});

test('operator SID does not change protected authority identity or service ownership', () => {
  const first = plan();
  const second = plan({ operatorSid: 'S-1-5-21-111111111-222222222-333333333-2002' });
  assert.equal(second.authorityIdentity, first.authorityIdentity);
  assert.equal(second.protectedRoot, first.protectedRoot);
  assert.deepEqual(second.service, first.service);
  assert.notEqual(second.serviceCommand, first.serviceCommand);
  assert.notDeepEqual(second.acl.readPipe.clients, first.acl.readPipe.clients);
  assert.deepEqual(second.acl.mutationPipe.clients, first.acl.mutationPipe.clients);
});

test('Windows authority plan rejects non-Windows paths and invalid SIDs', () => {
  assert.throws(() => plan({ stateDirectory: '/tmp/devbridge/state' }), /absolute Windows path/u);
  assert.throws(() => plan({ programDataDirectory: 'ProgramData' }), /absolute Windows path/u);
  assert.throws(() => plan({ operatorSid: 'operator' }), /Windows SID/u);
});
