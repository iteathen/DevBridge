import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  normalizeEnvironmentActivityPolicy,
} from '../src/runtime/environment-activity-policy.js';
import {
  linuxEnvironmentActivityHandoffTopology,
  publishLinuxEnvironmentActivityHandoff,
  readLinuxEnvironmentActivityHandoff,
} from '../src/setup/linux-environment-activity-handoff.js';

const STATE = '/home/operator/.devbridge/state';
const AUTHORITY = '/var/lib/devbridge/authority/state';
const RUN = '/run/devbridge';
const SERVICE = 991;
const GROUP = 993;

function policy() {
  return normalizeEnvironmentActivityPolicy({
    protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
    routes: [{ subject: '42', profile: 'profile-a', preferred: true, validation: true }],
  });
}

function document(value = policy()) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function info(kind, {
  uid = 0,
  gid = 0,
  mode = kind === 'directory' ? 0o755 : 0o640,
  size = document().length,
  nlink = 1,
} = {}) {
  return Object.freeze({
    uid,
    gid,
    mode,
    size,
    nlink,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  });
}

function fixture({ value = policy(), bytes = document(value) } = {}) {
  const topology = linuxEnvironmentActivityHandoffTopology({
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
    runDirectory: RUN,
  });
  const subject = digest(bytes);
  const entries = new Map([
    [topology.root, info('directory')],
    [topology.endpointDirectory, info('directory', { uid: SERVICE, gid: GROUP, mode: 0o2750 })],
    [topology.handoffDirectory, info('directory', { gid: GROUP, mode: 0o3770 })],
    [topology.source, info('file', { uid: SERVICE, gid: GROUP, mode: 0o600, size: bytes.length })],
    [topology.record, info('file', { uid: SERVICE, gid: GROUP, mode: 0o640, size: bytes.length })],
  ]);
  const calls = [];
  const ports = {
    async inspect(target) {
      calls.push(['inspect', target]);
      const entry = entries.get(target);
      if (!entry) throw new Error(`unexpected inspection: ${target}`);
      return entry;
    },
    async read(request) {
      calls.push(['read', request]);
      return {
        protocol: 'devbridge/linux-protected-storage-v1',
        path: request.contract.path,
        kind: 'file',
        size: bytes.length,
        digest: subject,
        content: Buffer.from(bytes),
      };
    },
    async transfer(request) {
      calls.push(['transfer', request]);
      return {
        protocol: 'devbridge/linux-protected-storage-v1',
        path: topology.record,
        kind: 'file',
        size: bytes.length,
        digest: subject,
        changed: true,
      };
    },
    async policyReader(directory) {
      calls.push(['policy', directory]);
      return structuredClone(value);
    },
  };
  return { value, bytes, subject, entries, calls, ports, topology };
}

test('Linux activity topology derives a fixed ordinary endpoint without disclosing protected storage', () => {
  const ordinary = linuxEnvironmentActivityHandoffTopology({ stateDirectory: STATE, runDirectory: RUN });
  assert.match(ordinary.identity, /^[a-f0-9]{32}$/u);
  assert.equal(ordinary.root, `${RUN}/${ordinary.identity}`);
  assert.equal(ordinary.endpointDirectory, `${ordinary.root}/activity`);
  assert.equal(ordinary.handoffDirectory, `${ordinary.root}/handoff`);
  assert.equal(ordinary.record, `${ordinary.handoffDirectory}/policy.json`);
  assert.equal(ordinary.source, null);

  const protectedTopology = linuxEnvironmentActivityHandoffTopology({
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
    runDirectory: RUN,
  });
  assert.equal(protectedTopology.source, `${AUTHORITY}/environment-activity/policy.json`);
  assert.throws(
    () => linuxEnvironmentActivityHandoffTopology({ stateDirectory: STATE, runDirectory: '/tmp/devbridge' }),
    /run directory is invalid/u,
  );
});

test('protected activity publication binds durable policy bytes to the fixed volatile handoff', async () => {
  const values = fixture();
  const result = await publishLinuxEnvironmentActivityHandoff({
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
    runDirectory: RUN,
    serviceUserId: SERVICE,
    policy: values.value,
  }, values.ports);
  assert.deepEqual(result, {
    protocol: 'devbridge/linux-environment-activity-handoff-v1',
    ready: true,
    changed: true,
    subject: values.subject,
  });
  assert.equal(values.calls.filter(([name]) => name === 'policy').length, 2);
  const transfer = values.calls.find(([name]) => name === 'transfer')[1];
  assert.deepEqual(transfer.output, {
    path: values.topology.record,
    ownerId: SERVICE,
    groupId: GROUP,
    mode: 0o640,
  });
  assert.deepEqual(transfer.parent, {
    path: values.topology.handoffDirectory,
    ownerId: 0,
    groupId: GROUP,
    mode: 0o3770,
  });
});

test('protected activity publication rejects authority and durable-state drift before export', async () => {
  for (const [target, replacement, pattern] of [
    ['root', info('directory', { uid: SERVICE }), /root authority is invalid/u],
    ['endpointDirectory', info('directory', { uid: SERVICE + 1, gid: GROUP, mode: 0o2750 }), /service identity changed/u],
    ['handoffDirectory', info('directory', { gid: GROUP, mode: 0o770 }), /directory authority is invalid/u],
    ['source', info('symlink', { uid: SERVICE, gid: GROUP, mode: 0o600 }), /policy authority is invalid/u],
    ['source', info('file', { uid: SERVICE, gid: GROUP, mode: 0o640 }), /policy authority is invalid/u],
  ]) {
    const values = fixture();
    values.entries.set(values.topology[target], replacement);
    await assert.rejects(() => publishLinuxEnvironmentActivityHandoff({
      stateDirectory: STATE,
      authorityDirectory: AUTHORITY,
      runDirectory: RUN,
      serviceUserId: SERVICE,
      policy: values.value,
    }, values.ports), pattern);
    assert.equal(values.calls.some(([name]) => name === 'transfer'), false);
  }

  const changed = fixture();
  let reads = 0;
  changed.ports.policyReader = async () => {
    reads += 1;
    return reads === 1 ? changed.value : { ...changed.value, routes: [] };
  };
  await assert.rejects(() => publishLinuxEnvironmentActivityHandoff({
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
    runDirectory: RUN,
    serviceUserId: SERVICE,
    policy: changed.value,
  }, changed.ports), /policy changed/u);
});

test('ordinary activity reader accepts only the fixed service-owned export', async () => {
  const values = fixture();
  const loaded = await readLinuxEnvironmentActivityHandoff({
    stateDirectory: STATE,
    runDirectory: RUN,
  }, values.ports);
  assert.deepEqual(loaded, {
    protocol: 'devbridge/linux-environment-activity-handoff-v1',
    policy: values.value,
    subject: values.subject,
  });
  const request = values.calls.find(([name]) => name === 'read')[1];
  assert.deepEqual(request.contract, {
    path: values.topology.record,
    ownerId: SERVICE,
    groupId: GROUP,
    mode: 0o640,
  });
});

test('ordinary activity reader rejects linked, foreign, malformed, and widened exports', async () => {
  for (const replacement of [
    info('file', { uid: 0, gid: GROUP }),
    info('file', { uid: SERVICE, gid: GROUP + 1 }),
    info('file', { uid: SERVICE, gid: GROUP, mode: 0o660 }),
    info('file', { uid: SERVICE, gid: GROUP, nlink: 2 }),
    info('symlink', { uid: SERVICE, gid: GROUP }),
  ]) {
    const values = fixture();
    values.entries.set(values.topology.record, replacement);
    await assert.rejects(() => readLinuxEnvironmentActivityHandoff({
      stateDirectory: STATE,
      runDirectory: RUN,
    }, values.ports), /handoff authority is invalid/u);
    assert.equal(values.calls.some(([name]) => name === 'read'), false);
  }

  for (const bytes of [
    Buffer.from('{ '),
    Buffer.from(JSON.stringify({ protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: [], extra: true })),
  ]) {
    const values = fixture({ bytes });
    await assert.rejects(() => readLinuxEnvironmentActivityHandoff({
      stateDirectory: STATE,
      runDirectory: RUN,
    }, values.ports), /invalid JSON|extra is not allowed/u);
  }
});

test('activity handoff source remains isolated from provider and repository identities', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-environment-activity-handoff.js', import.meta.url)), 'utf8');
  for (const forbidden of [
    'Hyper-V', 'libvirt', 'QEMU', 'providerName', 'repositoryName', 'virtualMachineName',
    'imagePath', 'commandPath', 'credential', 'systemdUnit',
  ]) assert.doesNotMatch(source, new RegExp(forbidden, 'iu'));
});
