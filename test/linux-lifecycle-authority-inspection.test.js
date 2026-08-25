import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLinuxLifecycleAuthorityPlan } from '../src/setup/linux-lifecycle-authority.js';
import {
  inspectLinuxLifecycleAuthorityHost,
  inspectLinuxLifecycleAuthorityState,
  LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
  LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  LINUX_LIFECYCLE_AUTHORITY_PROVIDER_SOCKETS,
} from '../src/setup/linux-lifecycle-authority-inspection.js';

function fakeInfo({ kind, uid, gid, mode, size = 128 }) {
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

function missing(path) {
  const error = new Error(`missing ${path}`);
  error.code = 'ENOENT';
  throw error;
}

function fixture({ operatorInProvider = false, providerMode = 0o770 } = {}) {
  const stateDirectory = '/home/alice/.devbridge/state';
  const plan = createLinuxLifecycleAuthorityPlan({ stateDirectory, operatorName: 'alice', providerGroup: 'libvirt' });
  const serviceUid = 995;
  const readGid = 994;
  const coordinationGid = 993;
  const providerGid = 108;
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash',
    `${plan.service.user}:x:${serviceUid}:${readGid}:DevBridge:/nonexistent:/usr/sbin/nologin`,
    '',
  ].join('\n');
  const providerMembers = operatorInProvider ? `${plan.service.user},alice` : plan.service.user;
  const group = [
    'root:x:0:',
    'alice:x:1000:',
    `${plan.service.readGroup}:x:${readGid}:alice`,
    `${plan.service.coordinationGroup}:x:${coordinationGid}:${plan.service.user},alice`,
    `libvirt:x:${providerGid}:${providerMembers}`,
    '',
  ].join('\n');
  const ownership = `${JSON.stringify({
    protocol: LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
    authorityIdentity: plan.authorityIdentity,
    serviceName: plan.service.name,
    operatorName: 'alice',
    providerGroup: 'libvirt',
    stateMigrationComplete: true,
    runtime: { packageDigest: 'a'.repeat(64), nodeDigest: 'b'.repeat(64) },
    serviceConfigured: true,
    serviceReady: true,
  })}\n`;

  const stats = new Map([
    [LINUX_LIFECYCLE_AUTHORITY_PROVIDER_SOCKETS[0], fakeInfo({ kind: 'socket', uid: 0, gid: providerGid, mode: providerMode })],
    [LINUX_LIFECYCLE_AUTHORITY_PROVIDER_SOCKETS[1], fakeInfo({ kind: 'socket', uid: 0, gid: 0, mode: 0o700 })],
    [plan.service.unitPath, fakeInfo({ kind: 'file', uid: 0, gid: 0, mode: 0o644, size: plan.service.unit.length })],
    [plan.protectedRoot, fakeInfo({ kind: 'directory', uid: 0, gid: 0, mode: 0o755 })],
    [plan.authorityDirectory, fakeInfo({ kind: 'directory', uid: serviceUid, gid: 0, mode: 0o700 })],
    [plan.runtime.binDirectory, fakeInfo({ kind: 'directory', uid: 0, gid: 0, mode: 0o755 })],
    [plan.runtime.runtimeDirectory, fakeInfo({ kind: 'directory', uid: 0, gid: 0, mode: 0o755 })],
    [plan.runtime.packageDirectory, fakeInfo({ kind: 'directory', uid: 0, gid: 0, mode: 0o755 })],
    [plan.runtime.nodeExecutable, fakeInfo({ kind: 'file', uid: 0, gid: 0, mode: 0o555 })],
    [plan.runtime.packageManifest, fakeInfo({ kind: 'file', uid: 0, gid: 0, mode: 0o444 })],
    [plan.runtime.serviceEntry, fakeInfo({ kind: 'file', uid: 0, gid: 0, mode: 0o444 })],
    [plan.ownershipManifest, fakeInfo({ kind: 'file', uid: 0, gid: 0, mode: 0o444, size: ownership.length })],
    [plan.endpoints.runRoot, fakeInfo({ kind: 'directory', uid: 0, gid: 0, mode: 0o755 })],
    [plan.endpoints.read.directory, fakeInfo({ kind: 'directory', uid: serviceUid, gid: readGid, mode: 0o770 })],
    [plan.endpoints.mutation.directory, fakeInfo({ kind: 'directory', uid: serviceUid, gid: 0, mode: 0o700 })],
  ]);
  const loads = new Map([
    ['/etc/passwd', passwd],
    ['/etc/group', group],
    [plan.service.unitPath, plan.service.unit],
    [plan.ownershipManifest, ownership],
  ]);
  const stat = async (path) => stats.has(path) ? stats.get(path) : missing(path);
  const load = async (path) => loads.has(path) ? loads.get(path) : missing(path);
  const invocations = [];
  const invoke = async (request) => {
    invocations.push(request);
    return {
      exitCode: 0,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
      stdout: [
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=running',
        'MainPID=4242',
        `FragmentPath=${plan.service.unitPath}`,
        `User=${plan.service.user}`,
        `Group=${plan.service.readGroup}`,
        `SupplementaryGroups=${plan.service.coordinationGroup} libvirt`,
        '',
      ].join('\n'),
      stderr: '',
    };
  };
  return { plan, stat, load, invoke, invocations };
}

async function inspect(values) {
  const host = await inspectLinuxLifecycleAuthorityHost({ platform: 'linux' }, {
    stat: values.stat,
    load: values.load,
    userInfo: () => ({ username: 'alice', uid: 1000, gid: 1000 }),
  });
  const state = await inspectLinuxLifecycleAuthorityState({
    plan: values.plan,
    host,
    platform: 'linux',
    invoke: values.invoke,
    environment: {},
  }, { stat: values.stat, load: values.load });
  return { host, state };
}

test('host inspection selects the qemu system socket capability without treating proxy compatibility sockets as authority', async () => {
  const values = fixture();
  const host = await inspectLinuxLifecycleAuthorityHost({ platform: 'linux' }, {
    stat: values.stat,
    load: values.load,
    userInfo: () => ({ username: 'alice', uid: 1000, gid: 1000 }),
  });
  assert.equal(host.protocol, LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL);
  assert.equal(host.provider.available, true);
  assert.equal(host.provider.socket, '/run/libvirt/virtqemud-sock');
  assert.equal(host.provider.group, 'libvirt');
  assert.equal(host.ordinaryProviderMember, false);
});

test('host inspection fails closed when the selected provider management socket is world-accessible', async () => {
  const values = fixture({ providerMode: 0o777 });
  await assert.rejects(() => inspectLinuxLifecycleAuthorityHost({ platform: 'linux' }, {
    stat: values.stat,
    load: values.load,
    userInfo: () => ({ username: 'alice', uid: 1000, gid: 1000 }),
  }), /bounded group-only capability/u);
});

test('host inspection exposes pre-existing ordinary provider membership as negative-capability evidence', async () => {
  const values = fixture({ operatorInProvider: true });
  const host = await inspectLinuxLifecycleAuthorityHost({ platform: 'linux' }, {
    stat: values.stat,
    load: values.load,
    userInfo: () => ({ username: 'alice', uid: 1000, gid: 1000 }),
  });
  assert.equal(host.ordinaryProviderMember, true);
});

test('authority state inspection proves exact account, unit, root-owned runtime, socket and provider shape without mutation', async () => {
  const values = fixture();
  const { state } = await inspect(values);
  assert.equal(state.authorityIdentity, values.plan.authorityIdentity);
  assert.deepEqual(state.accounts.service, {
    exists: true,
    nonRoot: true,
    home: true,
    shell: true,
    primaryReadGroup: true,
    unexpectedGroups: [],
  });
  assert.deepEqual(state.accounts.readGroup, { exists: true, service: true, operator: true });
  assert.deepEqual(state.accounts.coordinationGroup, { exists: true, service: true, operator: true });
  assert.deepEqual(state.accounts.providerGroup, { exists: true, service: true, operator: false });
  assert.equal(state.service.observable, true);
  assert.equal(state.service.exists, true);
  assert.equal(state.service.activeState, 'active');
  assert.equal(state.service.identity, true);
  assert.equal(state.service.groups, true);
  assert.equal(state.service.fragment, true);
  assert.deepEqual(state.service.unitFile, { exists: true, real: true, rootOwned: true, mode: true, exact: true });
  for (const evidence of Object.values(state.filesystem)) {
    assert.equal(evidence.exists, true);
    assert.equal(evidence.kind, true);
    assert.equal(evidence.owner, true);
    assert.equal(evidence.group, true);
    assert.equal(evidence.mode, true);
  }
  assert.equal(state.ownership.valid, true);
  assert.equal(state.ownership.record.runtime.packageDigest, 'a'.repeat(64));
  assert.equal(state.provider.operatorMember, false);
  assert.equal(state.provider.serviceMember, true);
  assert.equal(values.invocations.length, 1);
  assert.equal(values.invocations[0].executable, '/usr/bin/systemctl');
  assert.equal(values.invocations[0].arguments[0], 'show');
  assert.equal(values.invocations[0].arguments.includes('start'), false);
  assert.equal(values.invocations[0].arguments.includes('stop'), false);
  assert.equal(values.invocations[0].arguments.includes('restart'), false);
  assert.equal(values.invocations[0].arguments.includes('enable'), false);
});

test('unexpected service group membership is observed rather than silently accepted', async () => {
  const values = fixture();
  const originalLoad = values.load;
  values.load = async (path) => {
    if (path !== '/etc/group') return originalLoad(path);
    return `${await originalLoad(path)}docker:x:998:${values.plan.service.user}\n`;
  };
  const { state } = await inspect(values);
  assert.deepEqual(state.accounts.service.unexpectedGroups, ['docker']);
});

test('non-Linux host inspection is explicitly unattached and performs no filesystem work', async () => {
  let touched = false;
  const result = await inspectLinuxLifecycleAuthorityHost({ platform: 'win32' }, {
    stat: async () => { touched = true; throw new Error('unexpected'); },
    load: async () => { touched = true; throw new Error('unexpected'); },
    userInfo: () => { touched = true; return null; },
  });
  assert.equal(result.applicable, false);
  assert.equal(touched, false);
});

test('Linux authority inspection source contains no host mutation implementation', async () => {
  const file = fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-inspection.js', import.meta.url));
  const source = await readFile(file, 'utf8');
  for (const forbidden of ['useradd', 'groupadd', 'usermod', 'userdel', 'groupdel', 'chown', 'chmod', 'setfacl', 'sudo', 'pkexec', 'daemon-reload']) {
    assert.equal(source.includes(forbidden), false, `inspection must not contain ${forbidden}`);
  }
});
