import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  ENVIRONMENT_PROFILE_CONFIGURATION_RECORD_PROTOCOL,
  environmentProfileConfigurationDigest,
} from '../src/runtime/environment-profile-configuration.js';
import { ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY } from '../src/state/environment-profile-configuration-state-store.js';
import {
  linuxEnvironmentConfigurationHandoffTopology,
  publishLinuxEnvironmentConfigurationHandoff,
  readLinuxEnvironmentConfigurationHandoff,
} from '../src/setup/linux-environment-configuration-handoff.js';

const STATE = '/home/operator/.devbridge/state';
const RUN = '/run/devbridge';
const OPERATOR = 1001;
const SERVICE = 991;
const GROUP = 993;

function record(revision = 1) {
  const configuration = {
    protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
    declarations: [],
  };
  return {
    protocol: ENVIRONMENT_PROFILE_CONFIGURATION_RECORD_PROTOCOL,
    revision,
    digest: environmentProfileConfigurationDigest(configuration),
    configuration,
    updatedAt: '2026-08-29T12:00:00.000Z',
  };
}

function document(value = record()) {
  return Buffer.from(JSON.stringify({ [ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY]: value }), 'utf8');
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

function fixture({ accepted = record(), bytes = document(accepted) } = {}) {
  const topology = linuxEnvironmentConfigurationHandoffTopology({ stateDirectory: STATE, runDirectory: RUN });
  const entries = new Map([
    [topology.root, info('directory')],
    [topology.handoffDirectory, info('directory', { gid: GROUP, mode: 0o3770 })],
    [topology.source, info('file', { uid: OPERATOR, gid: OPERATOR, mode: 0o600, size: bytes.length })],
    [topology.record, info('file', { uid: OPERATOR, gid: GROUP, mode: 0o640, size: bytes.length })],
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
        digest: 'f'.repeat(64),
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
        digest: 'f'.repeat(64),
        changed: true,
      };
    },
    async recordReader() {
      calls.push(['record']);
      return structuredClone(accepted);
    },
  };
  return { accepted, bytes, calls, entries, ports, topology };
}

test('Linux configuration handoff topology derives only fixed authority-local paths', () => {
  const topology = linuxEnvironmentConfigurationHandoffTopology({ stateDirectory: STATE, runDirectory: RUN });
  assert.match(topology.identity, /^[a-f0-9]{32}$/u);
  assert.equal(topology.root, `${RUN}/${topology.identity}`);
  assert.equal(topology.endpointDirectory, `${topology.root}/configuration`);
  assert.equal(topology.handoffDirectory, `${topology.root}/handoff`);
  assert.equal(topology.record, `${topology.root}/handoff/state.json`);
  assert.equal(topology.source, `${STATE}/environment-profile-configuration/state.json`);
  assert.throws(
    () => linuxEnvironmentConfigurationHandoffTopology({ stateDirectory: STATE, runDirectory: '/tmp/devbridge' }),
    /run directory is invalid/u,
  );
});

test('ordinary publisher binds one accepted subject to one exact volatile transfer', async () => {
  const values = fixture();
  const result = await publishLinuxEnvironmentConfigurationHandoff({
    stateDirectory: STATE,
    runDirectory: RUN,
    record: values.accepted,
    userId: OPERATOR,
  }, values.ports);
  assert.deepEqual(result, {
    protocol: 'devbridge/linux-environment-configuration-handoff-v1',
    ready: true,
    changed: true,
    revision: 1,
    subject: values.accepted.digest,
  });
  assert.equal(values.calls.filter(([name]) => name === 'record').length, 2);
  const transfer = values.calls.find(([name]) => name === 'transfer')[1];
  assert.deepEqual(transfer.output, {
    path: values.topology.record,
    ownerId: OPERATOR,
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

test('ordinary publisher rejects authority and accepted-subject drift before publication', async () => {
  for (const [target, replacement, pattern] of [
    ['root', info('directory', { uid: OPERATOR }), /root authority is invalid/u],
    ['handoffDirectory', info('directory', { gid: GROUP, mode: 0o770 }), /directory authority is invalid/u],
    ['source', info('symlink', { uid: OPERATOR }), /source authority is invalid/u],
    ['source', info('file', { uid: OPERATOR, gid: OPERATOR, mode: 0o600, nlink: 2 }), /source authority is invalid/u],
  ]) {
    const values = fixture();
    values.entries.set(values.topology[target], replacement);
    await assert.rejects(() => publishLinuxEnvironmentConfigurationHandoff({
      stateDirectory: STATE,
      runDirectory: RUN,
      record: values.accepted,
      userId: OPERATOR,
    }, values.ports), pattern);
    assert.equal(values.calls.some(([name]) => name === 'transfer'), false);
  }

  const changed = fixture();
  let reads = 0;
  changed.ports.recordReader = async () => {
    reads += 1;
    return reads === 1 ? changed.accepted : record(2);
  };
  await assert.rejects(() => publishLinuxEnvironmentConfigurationHandoff({
    stateDirectory: STATE,
    runDirectory: RUN,
    record: changed.accepted,
    userId: OPERATOR,
  }, changed.ports), /subject changed/u);
});

test('protected reader accepts only the fixed policy-bound record', async () => {
  const values = fixture();
  const loaded = await readLinuxEnvironmentConfigurationHandoff({
    stateDirectory: STATE,
    runDirectory: RUN,
    serviceUserId: SERVICE,
  }, values.ports);
  assert.deepEqual(loaded, values.accepted);
  const request = values.calls.find(([name]) => name === 'read')[1];
  assert.deepEqual(request.contract, {
    path: values.topology.record,
    ownerId: OPERATOR,
    groupId: GROUP,
    mode: 0o640,
  });
});

test('protected reader rejects service-owned, linked, foreign, malformed, and widened state', async () => {
  for (const replacement of [
    info('file', { uid: 0, gid: GROUP }),
    info('file', { uid: SERVICE, gid: GROUP }),
    info('file', { uid: OPERATOR, gid: GROUP + 1 }),
    info('file', { uid: OPERATOR, gid: GROUP, mode: 0o660 }),
    info('file', { uid: OPERATOR, gid: GROUP, nlink: 2 }),
    info('symlink', { uid: OPERATOR, gid: GROUP }),
  ]) {
    const values = fixture();
    values.entries.set(values.topology.record, replacement);
    await assert.rejects(() => readLinuxEnvironmentConfigurationHandoff({
      stateDirectory: STATE,
      runDirectory: RUN,
      serviceUserId: SERVICE,
    }, values.ports), /handoff authority is invalid/u);
    assert.equal(values.calls.some(([name]) => name === 'read'), false);
  }

  for (const bytes of [
    Buffer.from('{ '),
    Buffer.from(JSON.stringify({
      [ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY]: record(),
      extra: true,
    })),
    Buffer.from(JSON.stringify({ [ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY]: { ...record(), digest: '0'.repeat(64) } })),
  ]) {
    const values = fixture({ bytes });
    await assert.rejects(() => readLinuxEnvironmentConfigurationHandoff({
      stateDirectory: STATE,
      runDirectory: RUN,
      serviceUserId: SERVICE,
    }, values.ports), /invalid JSON|unexpected state|digest is invalid/u);
  }
});

test('handoff source remains isolated from provider and topology identities', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-environment-configuration-handoff.js', import.meta.url)), 'utf8');
  for (const forbidden of [
    'Hyper-V', 'libvirt', 'QEMU', 'providerName', 'repositoryName', 'virtualMachineName',
    'imagePath', 'commandPath', 'credential', 'systemdUnit',
  ]) assert.doesNotMatch(source, new RegExp(forbidden, 'iu'));
});
