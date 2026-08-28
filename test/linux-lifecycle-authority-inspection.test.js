import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  bindLinuxLifecycleAuthorityRuntime,
  createLinuxLifecycleAuthorityPlan,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  inspectLinuxLifecycleAuthorityState,
  LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
  LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-inspection.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-generation.js';
import { LINUX_LOCAL_IDENTITIES_PROTOCOL } from '../src/setup/linux-local-identities.js';
import { observeLinuxService } from '../src/setup/linux-service-observation.js';

const PACKAGE_DIGEST = 'a'.repeat(64);
const NODE_DIGEST = 'b'.repeat(64);

function plan() {
  return bindLinuxLifecycleAuthorityRuntime(createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/home/alice/.devbridge/state',
    operatorName: 'alice',
    managementGroup: 'provider-control',
  }), { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
}

function info(kind, { uid, gid, mode, size = 128 }) {
  return Object.freeze({
    uid,
    gid,
    mode,
    size,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSocket: () => kind === 'socket',
    isSymbolicLink: () => kind === 'symlink',
  });
}

function fixture({ extraServiceGroup = false, serviceType = 'exec' } = {}) {
  const selected = plan();
  const serviceUid = 995;
  const readGid = 994;
  const coordinationGid = 993;
  const managementGid = 108;
  const serviceGroups = [readGid, coordinationGid, managementGid, ...(extraServiceGroup ? [998] : [])].sort((left, right) => left - right);
  const identities = Object.freeze({
    protocol: LINUX_LOCAL_IDENTITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    accounts: Object.freeze([
      Object.freeze({ name: 'alice', record: Object.freeze({ name: 'alice', uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash' }), groupIds: Object.freeze([coordinationGid, readGid, 1000].sort((left, right) => left - right)) }),
      Object.freeze({ name: selected.service.user, record: Object.freeze({ name: selected.service.user, uid: serviceUid, gid: readGid, home: '/nonexistent', shell: '/usr/sbin/nologin' }), groupIds: Object.freeze(serviceGroups) }),
    ]),
    groups: Object.freeze([
      Object.freeze({ name: 'root', record: Object.freeze({ name: 'root', gid: 0, members: Object.freeze([]) }) }),
      Object.freeze({ name: selected.service.readGroup, record: Object.freeze({ name: selected.service.readGroup, gid: readGid, members: Object.freeze(['alice']) }) }),
      Object.freeze({ name: selected.service.coordinationGroup, record: Object.freeze({ name: selected.service.coordinationGroup, gid: coordinationGid, members: Object.freeze([selected.service.user, 'alice']) }) }),
      Object.freeze({ name: selected.service.managementGroup, record: Object.freeze({ name: selected.service.managementGroup, gid: managementGid, members: Object.freeze([selected.service.user]) }) }),
    ]),
  });
  const ownership = Object.freeze({
    protocol: LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
    authorityIdentity: selected.authorityIdentity,
    serviceName: selected.service.name,
    operatorName: selected.service.operator,
    managementGroup: selected.service.managementGroup,
    localIdentity: Object.freeze({ serviceUid, readGid, coordinationGid, managementGid }),
    activeGeneration: selected.runtime.generation,
    stagedGeneration: null,
    retainedGenerations: Object.freeze([]),
  });
  const generation = Object.freeze({
    protocol: LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
    authorityIdentity: selected.authorityIdentity,
    generation: selected.runtime.generation,
    packageDigest: PACKAGE_DIGEST,
    nodeDigest: NODE_DIGEST,
  });
  const stats = new Map();
  const add = (target, kind, uid, gid, mode, size = 128) => stats.set(target, info(kind, { uid, gid, mode, size }));
  add(selected.service.unitPath, 'file', 0, 0, 0o644, selected.service.unit.length);
  add(selected.protectedRoot, 'directory', 0, 0, 0o755);
  add(selected.authorityDirectory, 'directory', serviceUid, 0, 0o700);
  add(selected.ownershipManifest, 'file', 0, 0, 0o444, JSON.stringify(ownership).length);
  add(selected.runtime.generationsDirectory, 'directory', 0, 0, 0o755);
  add(selected.runtime.generationDirectory, 'directory', 0, 0, 0o755);
  add(selected.runtime.binDirectory, 'directory', 0, 0, 0o755);
  add(selected.runtime.packageDirectory, 'directory', 0, 0, 0o755);
  add(selected.runtime.generationManifest, 'file', 0, 0, 0o444, JSON.stringify(generation).length);
  add(selected.runtime.nodeExecutable, 'file', 0, 0, 0o555);
  add(selected.runtime.packageManifest, 'file', 0, 0, 0o444);
  add(selected.runtime.serviceEntry, 'file', 0, 0, 0o444);
  add(selected.endpoints.runRoot, 'directory', 0, 0, 0o755);
  add(selected.endpoints.read.directory, 'directory', serviceUid, readGid, 0o750);
  add(selected.endpoints.mutation.directory, 'directory', serviceUid, 0, 0o700);
  add(selected.endpoints.read.endpoint, 'socket', serviceUid, readGid, 0o770);
  add(selected.endpoints.mutation.endpoint, 'socket', serviceUid, 0, 0o700);

  const loads = new Map([
    [selected.service.unitPath, selected.service.unit],
    [selected.ownershipManifest, JSON.stringify(ownership)],
    [selected.runtime.generationManifest, JSON.stringify(generation)],
    ['/proc/4242/status', [
      `Uid:\t${serviceUid}\t${serviceUid}\t${serviceUid}\t${serviceUid}`,
      `Gid:\t${readGid}\t${readGid}\t${readGid}\t${readGid}`,
      `Groups:\t${serviceGroups.join(' ')}`,
      '',
    ].join('\n')],
  ]);
  const invocations = [];
  const invoke = async (request) => {
    invocations.push(request);
    return Object.freeze({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
      stdout: [
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=running',
        'MainPID=4242',
        `FragmentPath=${selected.service.unitPath}`,
        `User=${selected.service.user}`,
        `Group=${selected.service.readGroup}`,
        `SupplementaryGroups=${selected.service.coordinationGroup} ${selected.service.managementGroup}`,
        `Type=${serviceType}`,
        'UnitFileState=enabled',
        'NeedDaemonReload=no',
        'DropInPaths=',
        '',
      ].join('\n'),
      stderr: '',
    });
  };
  const stat = async (target) => {
    if (stats.has(target)) return stats.get(target);
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  const load = async (target) => {
    if (loads.has(target)) return loads.get(target);
    throw new Error(`unexpected load ${target}`);
  };
  return {
    plan: selected,
    identities,
    ownership,
    generation,
    stats,
    loads,
    invocations,
    invoke,
    stat,
    load,
    link: async (target) => {
      assert.equal(target, '/proc/4242/exe');
      return selected.runtime.nodeExecutable;
    },
    measureRuntime: async () => Object.freeze({ evidence: Object.freeze({ packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST }) }),
    verifyRuntimeAccess: async () => Object.freeze({ ready: true }),
  };
}

async function inspect(values) {
  return inspectLinuxLifecycleAuthorityState({
    plan: values.plan,
    identities: values.identities,
    platform: 'linux',
  }, {
    stat: values.stat,
    load: values.load,
    link: values.link,
    readDirectory: async () => [],
    measureRuntime: values.measureRuntime,
    verifyRuntimeAccess: values.verifyRuntimeAccess,
    observeService: (request) => observeLinuxService(request, { invoke: values.invoke }),
  });
}

test('Linux authority inspection proves NSS, exact-generation, systemd, process, filesystem, and endpoint evidence read-only', async () => {
  const values = fixture();
  const observed = await inspect(values);
  assert.equal(observed.protocol, LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL);
  assert.equal(observed.identities.service, true);
  assert.equal(observed.identities.operator, true);
  assert.equal(observed.ownership.exact, true);
  assert.equal(observed.generation.exact, true);
  assert.equal(observed.service.unitExact, true);
  assert.equal(observed.service.startBoundary, true);
  assert.equal(observed.service.enabled, true);
  assert.equal(observed.service.definitionCurrent, true);
  assert.equal(observed.service.identity, true);
  assert.equal(observed.service.groups, true);
  assert.equal(observed.process.identity, true);
  assert.equal(observed.process.groups, true);
  assert.equal(observed.process.executable, true);
  assert.equal(Object.values(observed.filesystem).every((entry) => entry.exists && entry.kind && entry.owner && entry.group && entry.mode), true);
  assert.equal(observed.runtime.ready, true);
  assert.equal(values.invocations.length, 1);
  assert.equal(values.invocations[0].executable, '/usr/bin/systemctl');
  assert.equal(values.invocations[0].arguments.includes('show'), true);
  assert.equal(values.invocations[0].arguments.some((value) => ['start', 'stop', 'restart', 'enable', 'disable'].includes(value)), false);
});

test('NSS-only unexpected service membership and actual process membership are both rejected as evidence', async () => {
  const values = fixture({ extraServiceGroup: true });
  const observed = await inspect(values);
  assert.equal(observed.identities.service, false);
  assert.equal(observed.process.groups, false);
});

test('Type=simple does not satisfy the executable start boundary', async () => {
  const values = fixture({ serviceType: 'simple' });
  const observed = await inspect(values);
  assert.equal(observed.service.startBoundary, false);
});

test('group-writable read parent and widened runtime evidence remain visible failures', async () => {
  const values = fixture();
  const current = values.stats.get(values.plan.endpoints.read.directory);
  values.stats.set(values.plan.endpoints.read.directory, info('directory', { uid: current.uid, gid: current.gid, mode: 0o770 }));
  values.verifyRuntimeAccess = async () => Object.freeze({ ready: false });
  const observed = await inspect(values);
  assert.equal(observed.filesystem.readDirectory.mode, false);
  assert.equal(observed.runtime.ready, false);
});

test('runtime identity remains independently observable while an endpoint is stopped', async () => {
  const values = fixture();
  values.stats.delete(values.plan.endpoints.read.endpoint);
  const observed = await inspect(values);
  assert.equal(observed.filesystem.readEndpoint.exists, false);
  assert.equal(observed.runtime.ready, true);
});

test('a missing systemd unit is observable but never projected as an installed service', async () => {
  const values = fixture();
  values.invoke = async () => Object.freeze({
    exitCode: 0,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: [
      'LoadState=not-found',
      'ActiveState=inactive',
      'SubState=dead',
      'MainPID=0',
      'FragmentPath=',
      'User=',
      'Group=',
      'SupplementaryGroups=',
      'Type=',
      'UnitFileState=disabled',
      'NeedDaemonReload=no',
      'DropInPaths=',
      '',
    ].join('\n'),
    stderr: '',
  });
  const observed = await inspect(values);
  assert.equal(observed.service.observable, true);
  assert.equal(observed.service.exists, false);
  assert.equal(observed.service.identity, false);
});

test('ownership subject mismatch fails closed instead of adopting another installation', async () => {
  const values = fixture();
  values.loads.set(values.plan.ownershipManifest, JSON.stringify({ ...values.ownership, authorityIdentity: 'f'.repeat(32) }));
  await assert.rejects(() => inspect(values), /does not match this installation/u);
});

test('same-name numeric identity replacement invalidates ownership evidence', async () => {
  const values = fixture();
  values.loads.set(values.plan.ownershipManifest, JSON.stringify({
    ...values.ownership,
    localIdentity: { ...values.ownership.localIdentity, serviceUid: 996 },
  }));
  const observed = await inspect(values);
  assert.equal(observed.identities.service, true);
  assert.equal(observed.ownership.exists, true);
  assert.equal(observed.ownership.exact, false);
});

test('non-Linux inspection is explicitly unattached and performs no observation', async () => {
  let touched = false;
  const observed = await inspectLinuxLifecycleAuthorityState({ platform: 'win32' }, {
    stat: async () => { touched = true; },
    load: async () => { touched = true; },
    link: async () => { touched = true; },
    readDirectory: async () => { touched = true; },
    measureRuntime: async () => { touched = true; },
    verifyRuntimeAccess: async () => { touched = true; },
  });
  assert.equal(observed.applicable, false);
  assert.equal(touched, false);
});

test('lifecycle inspection delegates system-manager observation without retaining command mechanics', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-inspection.js', import.meta.url)), 'utf8');
  for (const forbidden of ['/usr/bin/systemctl', '--property=', 'daemon-reload', "'start'", "'stop'", "'enable'"]) {
    assert.equal(source.includes(forbidden), false, `lifecycle inspection retained system-manager mechanics through ${forbidden}`);
  }
});
