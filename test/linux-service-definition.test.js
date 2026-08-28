import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LINUX_PROTECTED_STORAGE_PROTOCOL } from '../src/setup/linux-protected-storage.js';
import { LINUX_SERVICE_MANAGER_PROTOCOL } from '../src/setup/linux-service-manager.js';
import { LINUX_SERVICE_OBSERVATION_PROTOCOL } from '../src/setup/linux-service-observation.js';
import {
  LINUX_SERVICE_DEFINITION_PROTOCOL,
  reconcileLinuxServiceDefinition,
} from '../src/setup/linux-service-definition.js';

const NAME = 'devbridge-authority-123456789abc.service';
const PATH = `/etc/systemd/system/${NAME}`;
const TARGET = '[Unit]\nDescription=target\n';
const PRIOR = '[Unit]\nDescription=prior\n';
const EXPECTED = Object.freeze({
  user: 'service_user',
  group: 'service_read',
  supplementaryGroups: Object.freeze(['service_coord', 'service_manage']),
  type: 'exec',
});

function fixture({
  content = null,
  current = false,
  enabled = false,
  exists = content != null,
  dropIns = false,
  filePolicy = true,
  throwAfterSave = false,
  observable = true,
} = {}) {
  const state = { content, current, enabled, exists, dropIns };
  const calls = [];
  let interrupted = false;
  const storage = (extra = {}) => Object.freeze({
    protocol: LINUX_PROTECTED_STORAGE_PROTOCOL,
    path: PATH,
    exists: state.content != null,
    kind: state.content != null && filePolicy,
    owner: state.content != null && filePolicy,
    group: state.content != null && filePolicy,
    mode: state.content != null && filePolicy,
    observedMode: state.content == null ? null : 0o644,
    ...extra,
  });
  const ports = {
    async inspect() { calls.push('inspect-file'); return storage(); },
    async load() {
      calls.push('load-file');
      const bytes = Buffer.from(state.content, 'utf8');
      return Object.freeze({ protocol: LINUX_PROTECTED_STORAGE_PROTOCOL, content: bytes, size: bytes.length });
    },
    async save({ content: bytes }) {
      calls.push('publish');
      state.content = bytes.toString('utf8');
      state.current = false;
      if (throwAfterSave && !interrupted) {
        interrupted = true;
        throw new Error('publication interrupted');
      }
      return storage({ changed: true });
    },
    async observe() {
      calls.push('observe-service');
      return Object.freeze({
        protocol: LINUX_SERVICE_OBSERVATION_PROTOCOL,
        platform: 'linux',
        applicable: true,
        observable,
        exists: state.exists,
        reason: observable ? null : 'unavailable',
        loadState: state.exists ? 'loaded' : 'not-found',
        activeState: state.exists && state.current ? 'active' : 'inactive',
        subState: state.exists && state.current ? 'running' : 'dead',
        mainPid: state.exists && state.current ? 4242 : 0,
        fragmentPath: state.exists ? PATH : '',
        user: state.exists ? EXPECTED.user : '',
        group: state.exists ? EXPECTED.group : '',
        supplementaryGroups: state.exists ? EXPECTED.supplementaryGroups : Object.freeze([]),
        type: state.exists ? EXPECTED.type : '',
        unitFileState: state.enabled ? 'enabled' : '',
        needsReload: !state.current,
        dropIns: state.dropIns,
        definitionCurrent: state.current && !state.dropIns,
      });
    },
    actions() {
      return Object.freeze({
        protocol: LINUX_SERVICE_MANAGER_PROTOCOL,
        platform: 'linux',
        applicable: true,
        async refresh() { calls.push('refresh'); state.exists = true; state.current = true; return true; },
        async persist() { calls.push('persist'); state.enabled = true; return true; },
        async quiesce() { throw new Error('not connected'); },
        async activate() { throw new Error('not connected'); },
      });
    },
  };
  return { state, calls, ports };
}

function reconcile(values, overrides = {}) {
  return reconcileLinuxServiceDefinition({
    name: NAME,
    path: PATH,
    definition: TARGET,
    acceptedDefinitions: [PRIOR],
    expected: EXPECTED,
    platform: 'linux',
    ...overrides,
  }, values.ports);
}

function effects(values) {
  return values.calls.filter((entry) => ['publish', 'refresh', 'persist'].includes(entry));
}

test('fresh definition publishes, refreshes, and persists through isolated owners', async () => {
  const values = fixture();
  const result = await reconcile(values);
  assert.deepEqual(result, { protocol: LINUX_SERVICE_DEFINITION_PROTOCOL, platform: 'linux', applicable: true, ready: true, changed: true });
  assert.equal(values.state.content, TARGET);
  assert.equal(values.state.current, true);
  assert.equal(values.state.enabled, true);
  assert.deepEqual(effects(values), ['publish', 'refresh', 'persist']);
});

test('enabled admitted prior definition upgrades without persistence churn', async () => {
  const values = fixture({ content: PRIOR, current: true, enabled: true, exists: true });
  const result = await reconcile(values);
  assert.equal(result.changed, true);
  assert.deepEqual(effects(values), ['publish', 'refresh']);
});

test('exact current enabled definition is a mutation-free no-op', async () => {
  const values = fixture({ content: TARGET, current: true, enabled: true, exists: true });
  const result = await reconcile(values);
  assert.equal(result.changed, false);
  assert.deepEqual(effects(values), []);
});

test('stale loaded target refreshes without rewriting exact bytes', async () => {
  const values = fixture({ content: TARGET, current: false, enabled: true, exists: true });
  await reconcile(values);
  assert.deepEqual(effects(values), ['refresh']);
});

test('completed publication is recovered by observation rather than replay', async () => {
  const values = fixture({ throwAfterSave: true });
  await assert.rejects(() => reconcile(values), /publication interrupted/u);
  assert.equal(values.state.content, TARGET);
  const resumed = await reconcile(values);
  assert.equal(resumed.ready, true);
  assert.equal(effects(values).filter((entry) => entry === 'publish').length, 1);
});

test('foreign bytes, file policy, fragment, identity, and drop-ins block before mutation', async () => {
  const foreignBytes = fixture({ content: '[Unit]\nForeign=yes\n', current: true, enabled: true, exists: true });
  await assert.rejects(() => reconcile(foreignBytes), /unadmitted bytes/u);

  const policy = fixture({ content: TARGET, current: true, enabled: true, exists: true, filePolicy: false });
  await assert.rejects(() => reconcile(policy), /file policy is invalid/u);

  const fragment = fixture({ content: TARGET, current: true, enabled: true, exists: true });
  const baseObserve = fragment.ports.observe;
  fragment.ports.observe = async () => ({ ...(await baseObserve()), fragmentPath: '/usr/lib/systemd/system/foreign.service' });
  await assert.rejects(() => reconcile(fragment), /fragment is foreign/u);

  const identity = fixture({ content: TARGET, current: true, enabled: true, exists: true });
  const identityObserve = identity.ports.observe;
  identity.ports.observe = async () => ({ ...(await identityObserve()), user: 'foreign_user' });
  await assert.rejects(() => reconcile(identity), /loaded identity is foreign/u);

  const dropIns = fixture({ content: TARGET, current: false, enabled: true, exists: true, dropIns: true });
  await assert.rejects(() => reconcile(dropIns), /loaded drop-ins/u);

  for (const values of [foreignBytes, policy, fragment, identity, dropIns]) assert.deepEqual(effects(values), []);
});

test('unobservable or inexact lower evidence fails closed', async () => {
  const unavailable = fixture({ observable: false });
  await assert.rejects(() => reconcile(unavailable), /not observable/u);

  const invalidActions = fixture();
  invalidActions.ports.actions = () => ({
    protocol: LINUX_SERVICE_MANAGER_PROTOCOL,
    platform: 'linux',
    applicable: true,
    refresh() {},
    persist() {},
    quiesce() {},
    activate() {},
    provider: 'forbidden',
  });
  await assert.rejects(() => reconcile(invalidActions), /unknown field/u);

  const widened = fixture();
  const baseObserve = widened.ports.observe;
  widened.ports.observe = async () => ({ ...(await baseObserve()), provider: 'forbidden' });
  await assert.rejects(() => reconcile(widened), /unknown field/u);

  const duplicateGroups = fixture({ content: TARGET, current: true, enabled: true, exists: true });
  const duplicateObserve = duplicateGroups.ports.observe;
  duplicateGroups.ports.observe = async () => ({
    ...(await duplicateObserve()),
    supplementaryGroups: ['service_coord', 'service_coord'],
  });
  await assert.rejects(() => reconcile(duplicateGroups), /observation is invalid/u);

  const incompleteFile = fixture({ content: TARGET, current: true, enabled: true, exists: true });
  const baseInspect = incompleteFile.ports.inspect;
  incompleteFile.ports.inspect = async () => {
    const { observedMode: _omitted, ...observed } = await baseInspect();
    return observed;
  };
  await assert.rejects(() => reconcile(incompleteFile), /file observation is invalid/u);

  for (const values of [unavailable, invalidActions, widened, duplicateGroups, incompleteFile]) assert.deepEqual(effects(values), []);
});

test('non-Linux definition is explicitly unattached and invokes no ports', async () => {
  let invoked = false;
  const poison = async () => { invoked = true; throw new Error('invoked'); };
  const result = await reconcileLinuxServiceDefinition({ platform: 'win32' }, {
    inspect: poison,
    load: poison,
    save: poison,
    observe: poison,
    actions: poison,
    reconcile: poison,
  });
  assert.deepEqual(result, { protocol: LINUX_SERVICE_DEFINITION_PROTOCOL, platform: 'win32', applicable: false });
  assert.equal(invoked, false);
});

test('definition composition rejects widened inputs and contains no neighboring topology', async () => {
  const values = fixture();
  await assert.rejects(() => reconcile(values, { provider: 'forbidden' }), /unknown field/u);
  await assert.rejects(() => reconcile(values, { signal: {} }), /cancellation signal is invalid/u);
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-service-definition.js', import.meta.url)), 'utf8');
  for (const forbidden of ['lifecycle', 'ownership', 'journal', 'provider', 'repository', 'virtualMachine', 'libvirt', 'qemu', 'qcow2', 'sudo', 'pkexec']) {
    assert.equal(source.includes(forbidden), false, `service definition gained neighboring authority through ${forbidden}`);
  }
});
