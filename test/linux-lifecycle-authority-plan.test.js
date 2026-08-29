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
  assert.match(value.configuration.authorityIdentity, /^[0-9a-f]{32}$/u);
  assert.notEqual(value.configuration.authorityIdentity, value.authorityIdentity);
  assert.equal(value.configuration.root, `/run/devbridge/${value.configuration.authorityIdentity}`);
  assert.equal(value.configuration.endpoint.endpoint, `${value.configuration.root}/configuration/environment-v1.sock`);
  assert.equal(value.configuration.handoff.record, `${value.configuration.root}/handoff/state.json`);
  assert.match(value.activity.authorityIdentity, /^[0-9a-f]{32}$/u);
  assert.notEqual(value.activity.authorityIdentity, value.authorityIdentity);
  assert.notEqual(value.activity.authorityIdentity, value.configuration.authorityIdentity);
  assert.equal(value.activity.root, `/run/devbridge/${value.activity.authorityIdentity}`);
  assert.equal(value.activity.endpoint.endpoint, `${value.activity.root}/activity/environment-v1.sock`);
  assert.equal(value.activity.handoff.record, `${value.activity.root}/handoff/policy.json`);
  assert.equal(value.endpoints.parentDirectory, '/run/devbridge');
  assert.equal(value.endpoints.definition.path, `/etc/tmpfiles.d/devbridge-lifecycle-authority-${value.authorityIdentity.slice(0, 12)}.conf`);
  assert.equal(value.endpoints.definition.content, [
    'd /run/devbridge 0755 root root -',
    `d /run/devbridge/${value.authorityIdentity} 0755 root root -`,
    `d /run/devbridge/${value.authorityIdentity}/governance 3770 root ${value.service.coordinationGroup} -`,
    `d /run/devbridge/${value.authorityIdentity}/read 0750 ${value.service.user} ${value.service.readGroup} -`,
    `d /run/devbridge/${value.authorityIdentity}/mutation 0700 ${value.service.user} root -`,
    `d /run/devbridge/${value.configuration.authorityIdentity} 0755 root root -`,
    `d /run/devbridge/${value.configuration.authorityIdentity}/configuration 2750 ${value.service.user} ${value.service.coordinationGroup} -`,
    `d /run/devbridge/${value.configuration.authorityIdentity}/handoff 3770 root ${value.service.coordinationGroup} -`,
    `d /run/devbridge/${value.activity.authorityIdentity} 0755 root root -`,
    `d /run/devbridge/${value.activity.authorityIdentity}/activity 2750 ${value.service.user} ${value.service.readGroup} -`,
    `d /run/devbridge/${value.activity.authorityIdentity}/handoff 3770 root ${value.service.readGroup} -`,
    `f /run/devbridge/${value.authorityIdentity}/governance/activity.lock 0660 root ${value.service.coordinationGroup} -`,
    '',
  ].join('\n'));
  assert.deepEqual(value.coordination, {
    directory: `/run/devbridge/${value.authorityIdentity}/governance`,
    group: value.service.coordinationGroup,
    directoryOwner: 'root',
    directoryMode: 0o3770,
    lock: { path: `/run/devbridge/${value.authorityIdentity}/governance/activity.lock`, owner: 'root', group: value.service.coordinationGroup, mode: 0o660 },
    shared: { path: `/run/devbridge/${value.authorityIdentity}/governance/shared.intent`, owner: 'alice', group: value.service.coordinationGroup, mode: 0o640 },
    exclusive: { path: `/run/devbridge/${value.authorityIdentity}/governance/exclusive.intent`, owner: value.service.user, group: value.service.coordinationGroup, mode: 0o640 },
    serviceWrite: true,
  });
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
  assert.deepEqual(value.configuration.endpoint, {
    endpoint: `${value.configuration.root}/configuration/environment-v1.sock`,
    directory: `${value.configuration.root}/configuration`,
    directoryOwner: value.service.user,
    directoryGroup: value.service.coordinationGroup,
    directoryMode: 0o2750,
    socketOwner: value.service.user,
    socketGroup: value.service.coordinationGroup,
    socketMode: 0o770,
  });
  assert.deepEqual(value.configuration.handoff, {
    directory: `${value.configuration.root}/handoff`,
    record: `${value.configuration.root}/handoff/state.json`,
    directoryOwner: 'root',
    directoryGroup: value.service.coordinationGroup,
    directoryMode: 0o3770,
    recordOwner: 'alice',
    recordGroup: value.service.coordinationGroup,
    recordMode: 0o640,
  });
  assert.deepEqual(value.activity.endpoint, {
    endpoint: `${value.activity.root}/activity/environment-v1.sock`,
    directory: `${value.activity.root}/activity`,
    directoryOwner: value.service.user,
    directoryGroup: value.service.readGroup,
    directoryMode: 0o2750,
    socketOwner: value.service.user,
    socketGroup: value.service.readGroup,
    socketMode: 0o770,
  });
  assert.deepEqual(value.activity.handoff, {
    directory: `${value.activity.root}/handoff`,
    record: `${value.activity.root}/handoff/policy.json`,
    source: `${value.authorityDirectory}/environment-activity/policy.json`,
    directoryOwner: 'root',
    directoryGroup: value.service.readGroup,
    directoryMode: 0o3770,
    recordOwner: value.service.user,
    recordGroup: value.service.readGroup,
    recordMode: 0o640,
  });
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
    value.configuration.endpoint.directory,
    value.activity.endpoint.directory,
    value.activity.handoff.directory,
  ];
  for (const target of writable) assert.match(unit, new RegExp(`"${target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'u'));
  assert.equal(unit.includes(`ReadWritePaths="${value.protectedRoot}"`), false);
  assert.equal(unit.includes(`ReadWritePaths="${value.configuration.handoff.directory}"`), false);
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
  const admission = { acquire: async () => { throw new Error('not exercised'); } };
  const fence = { acquire: async () => { throw new Error('not exercised'); } };
  const configuration = { inspect: async () => ({ ready: true }), reconcile: async () => ({ ready: true }) };
  const operator = {};
  const activity = {};
  const routeState = {
    async load() { return null; },
    async publish(value) { return value; },
    async reconcile() { calls.push({ routeReconcile: true }); return { ready: true, changed: false }; },
  };
  const service = await runLinuxLifecycleAuthorityService({
    argv: [
      '--state-directory', '/home/alice/.devbridge/state',
      '--authority-directory', '/var/lib/devbridge/lifecycle-authority/test/state',
      '--run-directory', '/run/devbridge',
    ],
    signalTarget: events,
    configurationFactory: (options) => {
      calls.push({ configuration: options });
      return configuration;
    },
    routeStateFactory: (options) => {
      calls.push({ routeState: options });
      return routeState;
    },
    admissionFactory: async (options) => {
      calls.push({ admission: options });
      return admission;
    },
    fenceFactory: (options) => {
      assert.deepEqual(options, { admission });
      return fence;
    },
    operatorFactory: async (options) => {
      calls.push({ operator: options });
      return operator;
    },
    activityFactory: async (options) => {
      calls.push({ activity: options });
      assert.equal(await options.policyLoader(), null);
      return activity;
    },
    socketPreparation: async (request) => {
      calls.push({ socket: request });
      return { ready: true, changed: false, endpoint: request.endpoint };
    },
    identityFactory: () => ({ userId: 995, primaryGroupId: 994, groupIds: [994, 993, 108] }),
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
  assert.deepEqual(calls.slice(0, 2), [{
    routeState: {
      stateDirectory: '/home/alice/.devbridge/state',
      authorityDirectory: '/var/lib/devbridge/lifecycle-authority/test/state',
      platform: 'linux',
      runDirectory: '/run/devbridge',
      serviceUserId: 995,
    },
  }, { routeReconcile: true }]);
  assert.deepEqual(calls[2], {
    configuration: {
      stateDirectory: '/home/alice/.devbridge/state',
      authorityDirectory: '/var/lib/devbridge/lifecycle-authority/test/state',
      platform: 'linux',
      runDirectory: '/run/devbridge',
    },
  });
  assert.deepEqual(calls[3], { admission: {
    access: 'exclusive',
    stateDirectory: '/home/alice/.devbridge/state',
    authorityDirectory: '/var/lib/devbridge/lifecycle-authority/test/state',
    platform: 'linux',
    runDirectory: '/run/devbridge',
  } });
  assert.deepEqual(calls[4], { operator: {
    stateDirectory: '/home/alice/.devbridge/state',
    authorityDirectory: '/var/lib/devbridge/lifecycle-authority/test/state',
    platform: 'linux',
    fence,
    routeState,
  } });
  assert.equal(calls[5].activity.stateDirectory, '/home/alice/.devbridge/state');
  assert.equal(calls[5].activity.authorityDirectory, '/var/lib/devbridge/lifecycle-authority/test/state');
  assert.equal(calls[5].activity.platform, 'linux');
  assert.equal(typeof calls[5].activity.policyLoader, 'function');
  const sockets = calls.slice(6, 10).map(({ socket }) => socket);
  assert.equal(sockets.length, 4);
  assert.deepEqual(sockets.map((entry) => entry.directoryMode), [0o750, 0o700, 0o2750, 0o2750]);
  assert.deepEqual(sockets.map((entry) => entry.socketGroupId), [994, 994, null, 994]);
  assert.deepEqual(calls[10], {
    stateDirectory: '/home/alice/.devbridge/state',
    authorityDirectory: '/var/lib/devbridge/lifecycle-authority/test/state',
    platform: 'linux',
    runDirectory: '/run/devbridge',
    operator,
    configuration,
    activity,
  });
  await service.close();
  await service.close();
  assert.equal(closes, 1);
});

test('Linux service entry rejects caller-selected topology and contains no provider mechanics', async () => {
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', '/state', '--authority-directory', '/authority', '--run-directory', '/run/devbridge', '--provider', 'anything',
  ]), /arguments are invalid/u);
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', 'relative', '--authority-directory', '/authority', '--run-directory', '/run/devbridge',
  ]), /absolute Linux path/u);
  assert.throws(() => parseLinuxLifecycleAuthorityServiceArguments([
    '--state-directory', '/state', '--state-directory', '/other', '--run-directory', '/run/devbridge',
  ]), /arguments are invalid/u);

  const file = fileURLToPath(new URL('../src/entry/linux-lifecycle-authority-service.mjs', import.meta.url));
  const source = await readFile(file, 'utf8');
  for (const forbidden of ['virsh', 'qemu', 'libvirt', 'sudo', 'pkexec', 'setfacl', 'useradd', 'groupadd', 'systemctl']) {
    assert.equal(source.includes(forbidden), false, `service entry must not contain ${forbidden}`);
  }
});
