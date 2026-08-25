import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createLinuxLifecycleAuthorityPlan,
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  parseLinuxLifecycleAuthorityServiceArguments,
  runLinuxLifecycleAuthorityService,
} from '../src/entry/linux-lifecycle-authority-service.mjs';

function plan(overrides = {}) {
  return createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/home/alice/.devbridge/state',
    operatorName: 'alice',
    providerGroup: 'libvirt',
    ...overrides,
  });
}

test('Linux authority plan derives one protected service identity and split local capabilities', () => {
  const value = plan();
  assert.equal(value.protocol, LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL);
  assert.match(value.authorityIdentity, /^[0-9a-f]{32}$/u);
  assert.equal(value.service.user, `db-auth-${value.authorityIdentity.slice(0, 12)}`);
  assert.equal(value.service.readGroup, `db-read-${value.authorityIdentity.slice(0, 12)}`);
  assert.equal(value.service.coordinationGroup, `db-coord-${value.authorityIdentity.slice(0, 12)}`);
  assert.equal(value.protectedRoot, `/var/lib/devbridge/lifecycle-authority/${value.authorityIdentity}`);
  assert.equal(value.authorityDirectory, `${value.protectedRoot}/state`);
  assert.equal(value.endpoints.read.endpoint, `/run/devbridge/${value.authorityIdentity}/read/environment-v1.sock`);
  assert.equal(value.endpoints.mutation.endpoint, `/run/devbridge/${value.authorityIdentity}/mutation/environment-v1.sock`);
  assert.equal(value.endpoints.read.mode, 0o770);
  assert.equal(value.endpoints.mutation.mode, 0o700);
  assert.equal(value.endpoints.mutation.group, 'root');
  assert.equal(value.access.protectedRoot.owner, 'root');
  assert.equal(value.access.protectedRoot.serviceWrite, false);
  assert.equal(value.access.protectedRuntime.owner, 'root');
  assert.equal(value.access.protectedRuntime.serviceWrite, false);
  assert.equal(value.access.authorityState.serviceWrite, true);
  assert.equal(value.access.protectedRoot.ordinaryUserWrite, false);
  assert.equal(value.access.authorityState.ordinaryUserWrite, false);
  assert.equal(value.service.account.shell, '/usr/sbin/nologin');
});

test('ordinary operator receives only installation read and coordination groups, never provider management', () => {
  const value = plan();
  assert.deepEqual(value.access.readCapability.members, [value.service.user, 'alice']);
  assert.deepEqual(value.access.coordination.members, [value.service.user, 'alice']);
  assert.deepEqual(value.access.providerManagement.members, [value.service.user]);
  assert.equal(value.access.providerManagement.ordinaryUserMember, false);
  assert.equal(value.access.providerManagement.members.includes('alice'), false);
});

test('systemd unit executes only the protected Node/package runtime with bounded local arguments', () => {
  const value = plan();
  const unit = value.service.unit;
  assert.match(unit, new RegExp(`User=${value.service.user}`, 'u'));
  assert.match(unit, new RegExp(`Group=${value.service.readGroup}`, 'u'));
  assert.match(unit, new RegExp(`SupplementaryGroups=${value.service.coordinationGroup} libvirt`, 'u'));
  assert.match(unit, /UMask=0007/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, new RegExp(value.runtime.nodeExecutable.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(unit, new RegExp(value.runtime.serviceEntry.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(unit, /--state-directory/u);
  assert.match(unit, /--authority-directory/u);
  assert.match(unit, new RegExp(`ReadWritePaths="${value.authorityDirectory}" "${value.coordination.directory}" "${value.endpoints.runRoot}"`, 'u'));
  assert.equal(unit.includes(`ReadWritePaths="${value.protectedRoot}"`), false);
  assert.equal(unit.includes('/home/alice/.devbridge/src'), false);
  assert.equal(unit.includes('sudo'), false);
  assert.equal(unit.includes('sh -c'), false);
  assert.equal(unit.includes('bash -c'), false);
});

test('systemd command escaping prevents percent-bearing local paths from becoming unit specifiers', () => {
  const value = plan({ stateDirectory: '/srv/dev%bridge/state' });
  assert.match(value.service.unit, /\/srv\/dev%%bridge\/state/u);
  assert.equal(value.service.unit.includes('/srv/dev%bridge/state'), false);
});

test('Linux authority plan rejects relative paths and unsafe local names', () => {
  assert.throws(() => plan({ stateDirectory: 'relative/state' }), /absolute Linux path/u);
  assert.throws(() => plan({ operatorName: 'alice;root' }), /bounded local account or group name/u);
  assert.throws(() => plan({ providerGroup: '../libvirt' }), /bounded local account or group name/u);
  assert.throws(() => plan({ runDirectory: 'run/devbridge' }), /absolute Linux path/u);
});

test('Linux service entry accepts only state and authority directories and composes the existing host', async () => {
  const events = new EventEmitter();
  events.exitCode = 0;
  const calls = [];
  let starts = 0;
  let closes = 0;
  const service = await runLinuxLifecycleAuthorityService({
    argv: ['--state-directory', '/home/alice/.devbridge/state', '--authority-directory', '/var/lib/devbridge/lifecycle-authority/test/state'],
    runDirectory: '/tmp/devbridge-authority-test',
    signalTarget: events,
    hostFactory: async (options) => {
      calls.push(options);
      return {
        authorityIdentity: 'a'.repeat(32),
        async start() { starts += 1; },
        async close() { closes += 1; },
      };
    },
  });
  assert.equal(starts, 1);
  assert.equal(service.authorityIdentity, 'a'.repeat(32));
  assert.deepEqual(calls, [{
    stateDirectory: '/home/alice/.devbridge/state',
    authorityDirectory: '/var/lib/devbridge/lifecycle-authority/test/state',
    platform: 'linux',
    runDirectory: '/tmp/devbridge-authority-test',
  }]);
  await service.close();
  assert.equal(closes, 1);
});

test('Linux service entry rejects caller-selected topology beyond its closed local paths', () => {
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', '/state', '--authority-directory', '/authority', '--provider', 'anything',
  ]), /arguments are invalid/u);
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', 'relative', '--authority-directory', '/authority',
  ]), /absolute Linux path/u);
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', '/state', '--state-directory', '/other',
  ]), /arguments are invalid/u);
});

test('Linux service entry contains no provider or privilege-escalation implementation identity', async () => {
  const file = fileURLToPath(new URL('../src/entry/linux-lifecycle-authority-service.mjs', import.meta.url));
  const source = await readFile(file, 'utf8');
  for (const forbidden of ['virsh', 'qemu', 'libvirt', 'sudo', 'pkexec', 'setfacl', 'useradd', 'groupadd', 'systemctl']) {
    assert.equal(source.includes(forbidden), false, `service entry must not contain ${forbidden}`);
  }
});
