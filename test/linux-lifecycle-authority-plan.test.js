import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  bindLinuxLifecycleAuthorityRuntime,
  createLinuxLifecycleAuthorityPlan,
  projectLinuxLifecycleAuthorityRuntime,
  linuxLifecycleAuthorityRuntimeGeneration,
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  parseLinuxLifecycleAuthorityServiceArguments,
  runLinuxLifecycleAuthorityService,
} from '../src/entry/linux-lifecycle-authority-service.mjs';

const PACKAGE_DIGEST = 'a'.repeat(64);
const NODE_DIGEST = 'b'.repeat(64);

function basePlan(overrides = {}) {
  return createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/home/alice/.devbridge/state',
    operatorName: 'alice',
    managementGroup: 'provider-control',
    ...overrides,
  });
}

function plan(overrides = {}) {
  return bindLinuxLifecycleAuthorityRuntime(basePlan(overrides), {
    packageDigest: PACKAGE_DIGEST,
    nodeDigest: NODE_DIGEST,
  });
}

test('Linux authority plan derives one exact runtime and split local capabilities', () => {
  const value = plan();
  assert.equal(value.protocol, LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL);
  assert.match(value.authorityIdentity, /^[0-9a-f]{32}$/u);
  assert.match(value.runtime.generation, /^[0-9a-f]{64}$/u);
  assert.equal(value.runtime.generation, linuxLifecycleAuthorityRuntimeGeneration({ packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST }));
  assert.equal(value.service.user, `db-auth-${value.authorityIdentity.slice(0, 12)}`);
  assert.equal(value.service.readGroup, `db-read-${value.authorityIdentity.slice(0, 12)}`);
  assert.equal(value.service.coordinationGroup, `db-coord-${value.authorityIdentity.slice(0, 12)}`);
  assert.deepEqual(value.storage, {
    parentDirectory: '/var/lib/devbridge',
    rootDirectory: '/var/lib/devbridge/lifecycle-authority',
  });
  assert.equal(value.protectedRoot, `/var/lib/devbridge/lifecycle-authority/${value.authorityIdentity}`);
  assert.equal(value.runtime.generationDirectory, `${value.runtime.generationsDirectory}/${value.runtime.generation}`);
  assert.equal(value.endpoints.read.endpoint, `/run/devbridge/${value.authorityIdentity}/read/environment-v1.sock`);
  assert.equal(value.endpoints.mutation.endpoint, `/run/devbridge/${value.authorityIdentity}/mutation/environment-v1.sock`);
  assert.equal(value.endpoints.parentDirectory, '/run/devbridge');
  assert.equal(value.endpoints.definition.path, `/etc/tmpfiles.d/devbridge-lifecycle-authority-${value.authorityIdentity.slice(0, 12)}.conf`);
  assert.equal(value.endpoints.definition.content, [
    'd /run/devbridge 0755 root root -',
    `d /run/devbridge/${value.authorityIdentity} 0755 root root -`,
    `d /run/devbridge/${value.authorityIdentity}/read 0750 ${value.service.user} ${value.service.readGroup} -`,
    `d /run/devbridge/${value.authorityIdentity}/mutation 0700 ${value.service.user} root -`,
    '',
  ].join('\n'));
  assert.equal(Object.hasOwn(value.endpoints.read, 'owner'), false);
  assert.equal(Object.hasOwn(value.endpoints.read, 'group'), false);
  assert.equal(value.endpoints.read.directoryOwner, value.service.user);
  assert.equal(value.endpoints.read.directoryGroup, value.service.readGroup);
  assert.equal(value.endpoints.read.socketOwner, value.service.user);
  assert.equal(value.endpoints.read.socketGroup, value.service.readGroup);
  assert.equal(value.endpoints.read.directoryMode, 0o750);
  assert.equal(value.endpoints.read.socketMode, 0o770);
  assert.equal(value.endpoints.mutation.directoryOwner, value.service.user);
  assert.equal(value.endpoints.mutation.directoryGroup, 'root');
  assert.equal(value.endpoints.mutation.socketOwner, value.service.user);
  assert.equal(value.endpoints.mutation.socketGroup, value.service.readGroup);
  assert.equal(value.endpoints.mutation.directoryMode, 0o700);
  assert.equal(value.endpoints.mutation.socketMode, 0o770);
  assert.equal(value.access.storageRoot.mode, 0o755);
  assert.equal(value.access.protectedRuntime.serviceWrite, false);
  assert.equal(value.access.refreshJournal.mode, 0o600);
  assert.equal(value.access.volatileDefinition.mode, 0o644);
  assert.equal(value.access.authorityState.serviceWrite, true);
});

test('ordinary operator receives read and coordination membership but never management membership', () => {
  const value = plan();
  assert.deepEqual(value.access.readCapability.members, [value.service.user, 'alice']);
  assert.deepEqual(value.access.coordination.members, [value.service.user, 'alice']);
  assert.deepEqual(value.access.management.members, [value.service.user]);
  assert.equal(value.access.management.members.includes('alice'), false);
});

test('systemd unit binds the exact protected generation and narrow writable studs', () => {
  const value = plan();
  const unit = value.service.unit;
  assert.match(unit, /Type=exec/u);
  assert.match(unit, new RegExp(`User=${value.service.user}`, 'u'));
  assert.match(unit, new RegExp(`Group=${value.service.readGroup}`, 'u'));
  assert.match(unit, new RegExp(`SupplementaryGroups=${value.service.coordinationGroup} provider-control`, 'u'));
  assert.match(unit, /UMask=0007/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /CapabilityBoundingSet=\n/u);
  assert.match(unit, new RegExp(value.runtime.nodeExecutable.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(unit, new RegExp(value.runtime.serviceEntry.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  const writable = [
    value.authorityDirectory,
    value.coordination.directory,
    value.endpoints.read.directory,
    value.endpoints.mutation.directory,
  ];
  for (const target of writable) assert.match(unit, new RegExp(`"${target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'u'));
  assert.equal(unit.includes(`ReadWritePaths="${value.protectedRoot}"`), false);
  assert.equal(unit.includes(value.runtime.generationDirectory) && unit.includes('ReadWritePaths=' + `"${value.runtime.generationDirectory}"`), false);
  assert.equal(unit.includes('sudo'), false);
  assert.equal(unit.includes('sh -c'), false);
});

test('runtime evidence is single-assignment and changes the exact generation', () => {
  const first = plan();
  const second = bindLinuxLifecycleAuthorityRuntime(basePlan(), { packageDigest: 'c'.repeat(64), nodeDigest: NODE_DIGEST });
  assert.notEqual(first.runtime.generation, second.runtime.generation);
  assert.notEqual(first.runtime.generationDirectory, second.runtime.generationDirectory);
  assert.throws(() => bindLinuxLifecycleAuthorityRuntime(first, { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST }), /already bound/u);
  assert.throws(() => bindLinuxLifecycleAuthorityRuntime(basePlan(), { packageDigest: 'x', nodeDigest: NODE_DIGEST }), /sha256 digest/u);
});

test('historical runtime projection derives exact rollback unit bytes without filename inference', () => {
  const base = createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/home/alice/.devbridge/state',
    operatorName: 'alice',
    managementGroup: 'provider-control',
  });
  const current = bindLinuxLifecycleAuthorityRuntime(base, { packageDigest: 'a'.repeat(64), nodeDigest: 'b'.repeat(64) });
  const historical = projectLinuxLifecycleAuthorityRuntime(current, { packageDigest: 'c'.repeat(64), nodeDigest: 'd'.repeat(64) });
  assert.notEqual(historical.runtime.generation, current.runtime.generation);
  assert.match(historical.service.unit, new RegExp(historical.runtime.generation, 'u'));
  assert.equal(historical.service.unit.includes(current.runtime.generation), false);
});

test('Linux plan rejects nonportable names, unsafe paths, and percent specifier expansion', () => {
  assert.throws(() => basePlan({ stateDirectory: 'relative/state' }), /absolute Linux path/u);
  assert.throws(() => basePlan({ operatorName: 'alice.example' }), /portable bounded/u);
  assert.throws(() => basePlan({ managementGroup: '../control' }), /portable bounded/u);
  assert.throws(() => basePlan({ managementGroup: 'a'.repeat(32) }), /portable bounded/u);
  assert.throws(() => basePlan({ runDirectory: '/run/dev bridge' }), /unsupported definition syntax/u);
  assert.throws(() => basePlan({ runDirectory: '/run/dev%bridge' }), /unsupported definition syntax/u);
  assert.throws(() => basePlan({ runDirectory: '/tmp/devbridge' }), /unsupported definition syntax/u);
  assert.throws(() => basePlan({ runDirectory: '/run/devbridge/../foreign' }), /unsupported definition syntax/u);
  const value = plan({ stateDirectory: '/srv/dev%bridge/state' });
  assert.match(value.service.unit, /\/srv\/dev%%bridge\/state/u);
  assert.equal(value.service.unit.includes('/srv/dev%bridge/state'), false);
});

test('Linux service entry accepts only local directories and composes the existing host', async () => {
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
  await service.close();
  assert.equal(closes, 1);
});

test('Linux service entry rejects caller-selected topology and contains no provider mechanics', async () => {
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', '/state', '--authority-directory', '/authority', '--provider', 'anything',
  ]), /arguments are invalid/u);
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', 'relative', '--authority-directory', '/authority',
  ]), /absolute Linux path/u);
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', '/state', '--state-directory', '/other',
  ]), /arguments are invalid/u);

  const file = fileURLToPath(new URL('../src/entry/linux-lifecycle-authority-service.mjs', import.meta.url));
  const source = await readFile(file, 'utf8');
  for (const forbidden of ['virsh', 'qemu', 'libvirt', 'sudo', 'pkexec', 'setfacl', 'useradd', 'groupadd', 'systemctl']) {
    assert.equal(source.includes(forbidden), false, `service entry must not contain ${forbidden}`);
  }
});
