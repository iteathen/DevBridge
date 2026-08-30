import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLinuxActivityAdmission } from '../src/app/linux-activity-admission.js';
import { createLinuxLifecycleAuthorityPlan } from '../src/setup/linux-lifecycle-authority.js';
import { LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL } from '../src/setup/linux-lifecycle-authority-records.js';

const IDS = Object.freeze({ serviceUid: 995, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 108 });

function info(kind, { uid, gid, mode, size = 0, ino, nlink = 1 }) {
  return Object.freeze({
    dev: 7, ino, uid, gid, mode, size, nlink, mtimeMs: 1, ctimeMs: 1,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  });
}

function fixture({ governanceMode = 0o3770, ownershipTransform = (value) => value } = {}) {
  const plan = createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/home/alice/.devbridge/state',
    operatorName: 'alice',
    managementGroup: Object.freeze({ name: 'provider-control', id: IDS.managementGid }),
  });
  const ownership = ownershipTransform({
    protocol: LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
    authorityIdentity: plan.authorityIdentity,
    serviceName: plan.service.name,
    operatorName: plan.service.operator,
    managementGroup: plan.service.managementGroup,
    managementGid: plan.service.managementGroupId,
    localIdentity: { ...IDS },
    activeGeneration: 'a'.repeat(64),
    stagedGeneration: null,
    retainedGenerations: [],
  });
  const ownershipBytes = Buffer.from(`${JSON.stringify(ownership)}\n`, 'utf8');
  const entries = new Map([
    [plan.endpoints.parentDirectory, info('directory', { uid: 0, gid: 0, mode: 0o755, ino: 1 })],
    [plan.endpoints.runRoot, info('directory', { uid: 0, gid: 0, mode: 0o755, ino: 2 })],
    [plan.endpoints.read.directory, info('directory', { uid: IDS.serviceUid, gid: IDS.readGid, mode: 0o750, ino: 3 })],
    [plan.coordination.directory, info('directory', { uid: 0, gid: IDS.coordinationGid, mode: governanceMode, ino: 4 })],
    [plan.coordination.lock.path, info('file', { uid: 0, gid: IDS.coordinationGid, mode: 0o660, ino: 5 })],
    [plan.protectedRoot, info('directory', { uid: 0, gid: 0, mode: 0o755, ino: 6 })],
    [plan.authorityDirectory, info('directory', { uid: IDS.serviceUid, gid: 0, mode: 0o700, ino: 7 })],
    [plan.ownershipManifest, info('file', { uid: 0, gid: 0, mode: 0o444, size: ownershipBytes.length, ino: 8 })],
  ]);
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const stat = async (target) => entries.get(target) ?? Promise.reject(missing());
  const load = async (target) => {
    if (target !== plan.ownershipManifest) throw new Error('foreign read');
    return Buffer.from(ownershipBytes);
  };
  const intents = [];
  const leases = [];
  const ports = {
    stat,
    load,
    getUid: () => IDS.operatorUid,
    getEffectiveUid: () => IDS.operatorUid,
    getGid: () => IDS.operatorUid,
    getEffectiveGid: () => IDS.operatorUid,
    getGroups: () => [IDS.operatorUid, IDS.readGid, IDS.coordinationGid],
    intentFactory(config) {
      intents.push(config);
      return { observe: async () => null, ensure: async (value) => value, clear: async () => true };
    },
    leaseFactory(config) {
      leases.push(config);
      return { acquire: async () => null };
    },
    gateFactory(value) {
      assert.equal(value.sharedIntent != null && value.exclusiveIntent != null && value.lease != null, true);
      return {
        shared: { acquire: async () => null, reconcile: async () => false },
        exclusive: { acquire: async () => { throw new Error('fixture'); } },
      };
    },
  };
  return { plan, entries, intents, leases, ports };
}

test('ordinary composition projects only exact shared admission topology', async () => {
  const values = fixture();
  const admission = await createLinuxActivityAdmission({
    access: 'shared',
    stateDirectory: values.plan.stateDirectory,
    platform: 'linux',
  }, values.ports);
  assert.equal(typeof admission.acquire, 'function');
  assert.equal(typeof admission.reconcile, 'function');
  assert.deepEqual(values.intents, [
    {
      directory: { path: values.plan.coordination.directory, ownerId: 0, groupId: IDS.coordinationGid, mode: 0o3770 },
      recordPath: values.plan.coordination.shared.path,
      ownerId: IDS.operatorUid,
      groupId: IDS.coordinationGid,
    },
    {
      directory: { path: values.plan.coordination.directory, ownerId: 0, groupId: IDS.coordinationGid, mode: 0o3770 },
      recordPath: values.plan.coordination.exclusive.path,
      ownerId: IDS.serviceUid,
      groupId: IDS.coordinationGid,
    },
  ]);
  assert.deepEqual(values.leases, [{ subjectPath: values.plan.coordination.lock.path }]);
});

test('protected composition binds immutable ownership, process identity, and exclusive admission', async () => {
  const values = fixture();
  Object.assign(values.ports, {
    getUid: () => IDS.serviceUid,
    getEffectiveUid: () => IDS.serviceUid,
    getGid: () => IDS.readGid,
    getEffectiveGid: () => IDS.readGid,
    getGroups: () => [IDS.readGid, IDS.coordinationGid, IDS.managementGid],
  });
  const admission = await createLinuxActivityAdmission({
    access: 'exclusive',
    stateDirectory: values.plan.stateDirectory,
    authorityDirectory: values.plan.authorityDirectory,
    platform: 'linux',
  }, values.ports);
  assert.equal(typeof admission.acquire, 'function');
  assert.equal(values.intents[0].ownerId, IDS.operatorUid);
  assert.equal(values.intents[1].ownerId, IDS.serviceUid);
});

test('foreign topology, process identity, ownership bytes, and widened requests fail before composition', async () => {
  const foreignTopology = fixture({ governanceMode: 0o770 });
  await assert.rejects(createLinuxActivityAdmission({
    access: 'shared', stateDirectory: foreignTopology.plan.stateDirectory, platform: 'linux',
  }, foreignTopology.ports), /topology policy/u);
  assert.equal(foreignTopology.intents.length, 0);

  const foreignIdentity = fixture();
  foreignIdentity.ports.getGroups = () => [IDS.operatorUid];
  await assert.rejects(createLinuxActivityAdmission({
    access: 'shared', stateDirectory: foreignIdentity.plan.stateDirectory, platform: 'linux',
  }, foreignIdentity.ports), /lacks its bound identity/u);

  const foreignOwnership = fixture({ ownershipTransform: (value) => ({ ...value, serviceName: 'foreign' }) });
  Object.assign(foreignOwnership.ports, {
    getUid: () => IDS.serviceUid,
    getEffectiveUid: () => IDS.serviceUid,
    getGid: () => IDS.readGid,
    getEffectiveGid: () => IDS.readGid,
    getGroups: () => [IDS.readGid, IDS.coordinationGid],
  });
  await assert.rejects(createLinuxActivityAdmission({
    access: 'exclusive', stateDirectory: foreignOwnership.plan.stateDirectory,
    authorityDirectory: foreignOwnership.plan.authorityDirectory, platform: 'linux',
  }, foreignOwnership.ports), /ownership record does not match/u);

  const reboundOwnership = fixture({ ownershipTransform: (value) => ({
    ...value,
    managementGid: value.managementGid + 1,
    localIdentity: { ...value.localIdentity, managementGid: value.localIdentity.managementGid + 1 },
  }) });
  Object.assign(reboundOwnership.ports, {
    getUid: () => IDS.serviceUid,
    getEffectiveUid: () => IDS.serviceUid,
    getGid: () => IDS.readGid,
    getEffectiveGid: () => IDS.readGid,
    getGroups: () => [IDS.readGid, IDS.coordinationGid, IDS.managementGid],
  });
  await assert.rejects(createLinuxActivityAdmission({
    access: 'exclusive', stateDirectory: reboundOwnership.plan.stateDirectory,
    authorityDirectory: reboundOwnership.plan.authorityDirectory, platform: 'linux',
  }, reboundOwnership.ports), /process lacks its bound identity/u);
  assert.equal(reboundOwnership.intents.length, 0);

  await assert.rejects(createLinuxActivityAdmission({
    access: 'shared', stateDirectory: '/state', platform: 'linux', provider: 'foreign',
  }, foreignIdentity.ports), /unknown field/u);
  await assert.rejects(createLinuxActivityAdmission({
    access: 'shared', stateDirectory: '/state', runDirectory: '/tmp/devbridge', platform: 'linux',
  }, foreignIdentity.ports), /unsupported topology syntax/u);
});

test('Linux composition source contains no provider, repository, or executable authority', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/app/linux-activity-admission.js', import.meta.url)), 'utf8');
  for (const forbidden of ['virsh', 'qemu', 'Hyper-V', 'repository', 'github', 'shell:', 'executable:']) {
    assert.equal(source.includes(forbidden), false, `activity composition must not contain ${forbidden}`);
  }
});
