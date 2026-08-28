import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  reconcileLinuxLocalIdentityContract,
} from '../src/setup/linux-local-identity-reconciliation.js';
import { LINUX_LOCAL_IDENTITIES_PROTOCOL } from '../src/setup/linux-local-identities.js';

const NAMES = Object.freeze({
  serviceAccount: 'db-auth-123456789abc',
  operatorAccount: 'alice',
  readGroup: 'db-read-123456789abc',
  coordinationGroup: 'db-coord-123456789abc',
  managementGroup: 'provider-control',
  home: '/nonexistent',
  shell: '/usr/sbin/nologin',
});

function fixture({ exact = false, extraServiceGroup = false, operatorManagement = false } = {}) {
  const accounts = new Map([[
    NAMES.operatorAccount,
    { name: NAMES.operatorAccount, uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash', groupIds: [1000] },
  ]]);
  const groups = new Map();
  const calls = [];
  const gids = new Map([
    [NAMES.readGroup, 994],
    [NAMES.coordinationGroup, 993],
    [NAMES.managementGroup, 992],
  ]);
  const installExact = () => {
    for (const [name, gid] of gids) groups.set(name, { name, gid, members: [] });
    accounts.set(NAMES.serviceAccount, {
      name: NAMES.serviceAccount,
      uid: 995,
      gid: gids.get(NAMES.readGroup),
      home: NAMES.home,
      shell: NAMES.shell,
      groupIds: [gids.get(NAMES.readGroup), gids.get(NAMES.coordinationGroup), gids.get(NAMES.managementGroup), ...(extraServiceGroup ? [991] : [])].sort((left, right) => left - right),
    });
    accounts.get(NAMES.operatorAccount).groupIds.push(gids.get(NAMES.readGroup), gids.get(NAMES.coordinationGroup));
    if (operatorManagement) accounts.get(NAMES.operatorAccount).groupIds.push(gids.get(NAMES.managementGroup));
    accounts.get(NAMES.operatorAccount).groupIds.sort((left, right) => left - right);
  };
  if (exact || extraServiceGroup || operatorManagement) installExact();

  const observe = async ({ accountNames, groupNames }) => Object.freeze({
    protocol: LINUX_LOCAL_IDENTITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    accounts: Object.freeze(accountNames.map((name) => {
      const value = accounts.get(name);
      return Object.freeze({
        name,
        record: value == null ? null : Object.freeze({ name, uid: value.uid, gid: value.gid, home: value.home, shell: value.shell }),
        groupIds: Object.freeze(value == null ? [] : [...value.groupIds]),
      });
    })),
    groups: Object.freeze(groupNames.map((name) => Object.freeze({
      name,
      record: groups.has(name) ? Object.freeze({ ...groups.get(name), members: Object.freeze([...groups.get(name).members]) }) : null,
    }))),
  });

  const invoke = async (request) => {
    calls.push(structuredClone(request));
    const args = request.arguments;
    if (request.executable === '/usr/sbin/groupadd') {
      const name = args.at(-1);
      groups.set(name, { name, gid: gids.get(name), members: [] });
    } else if (request.executable === '/usr/sbin/useradd') {
      accounts.set(NAMES.serviceAccount, {
        name: NAMES.serviceAccount,
        uid: 995,
        gid: gids.get(NAMES.readGroup),
        home: NAMES.home,
        shell: NAMES.shell,
        groupIds: [gids.get(NAMES.readGroup), gids.get(NAMES.coordinationGroup), gids.get(NAMES.managementGroup)].sort((left, right) => left - right),
      });
    } else if (request.executable === '/usr/sbin/usermod' && args.at(-1) === NAMES.serviceAccount) {
      accounts.get(NAMES.serviceAccount).groupIds = [gids.get(NAMES.readGroup), gids.get(NAMES.coordinationGroup), gids.get(NAMES.managementGroup)].sort((left, right) => left - right);
    } else if (request.executable === '/usr/sbin/usermod' && args.at(-1) === NAMES.operatorAccount) {
      const operator = accounts.get(NAMES.operatorAccount);
      operator.groupIds = [...new Set([...operator.groupIds, gids.get(NAMES.readGroup), gids.get(NAMES.coordinationGroup)])].sort((left, right) => left - right);
    } else throw new Error('unexpected identity mutation');
    return Object.freeze({ exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: '' });
  };
  return { accounts, groups, calls, observe, invoke };
}

function reconcile(values, options = {}) {
  return reconcileLinuxLocalIdentityContract({
    ...NAMES,
    claimEstablished: true,
    platform: 'linux',
    invoke: values.invoke,
    environment: {},
    ...options,
  }, { observe: values.observe });
}

test('fresh protected claim creates exact local identities and appends only ordinary capabilities', async () => {
  const values = fixture();
  const result = await reconcile(values);
  assert.equal(result.changed, true);
  assert.deepEqual(result.identity, { serviceUid: 995, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 992 });
  assert.deepEqual(values.calls.map((call) => [call.executable, call.arguments]), [
    ['/usr/sbin/groupadd', ['--system', '--', NAMES.readGroup]],
    ['/usr/sbin/groupadd', ['--system', '--', NAMES.coordinationGroup]],
    ['/usr/sbin/groupadd', ['--system', '--', NAMES.managementGroup]],
    ['/usr/sbin/useradd', ['--system', '--gid', NAMES.readGroup, '--groups', `${NAMES.coordinationGroup},${NAMES.managementGroup}`, '--home-dir', NAMES.home, '--shell', NAMES.shell, '--no-create-home', '--no-user-group', '--', NAMES.serviceAccount]],
    ['/usr/sbin/usermod', ['--append', '--groups', `${NAMES.readGroup},${NAMES.coordinationGroup}`, '--', NAMES.operatorAccount]],
  ]);
  assert.equal(values.calls.every((call) => call.input === null && call.environment != null), true);
});

test('exact numeric-bound identity is a mutation-free no-op', async () => {
  const values = fixture({ exact: true });
  const result = await reconcile(values, { expectedIdentity: { serviceUid: 995, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 992 } });
  assert.equal(result.changed, false);
  assert.deepEqual(values.calls, []);
});

test('interrupted claimed service membership is replaced exactly without replacing operator groups', async () => {
  const values = fixture({ extraServiceGroup: true });
  values.accounts.get(NAMES.operatorAccount).groupIds.push(777);
  const result = await reconcile(values);
  assert.equal(result.changed, true);
  assert.deepEqual(values.accounts.get(NAMES.serviceAccount).groupIds, [992, 993, 994]);
  assert.equal(values.accounts.get(NAMES.operatorAccount).groupIds.includes(777), true);
  assert.equal(values.calls.some((call) => call.arguments.includes('--append') && call.arguments.at(-1) === NAMES.serviceAccount), false);
});

test('numeric identity drift and ordinary management membership fail before mutation', async () => {
  const drift = fixture({ exact: true });
  await assert.rejects(() => reconcile(drift, { expectedIdentity: { serviceUid: 996, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 992 } }), /numeric binding changed/u);
  assert.deepEqual(drift.calls, []);

  const widened = fixture({ operatorManagement: true });
  await assert.rejects(() => reconcile(widened), /operator already has management authority/u);
  assert.deepEqual(widened.calls, []);
});

test('identity mutation requires an established protected claim and stays isolated from neighboring owners', async () => {
  const values = fixture();
  await assert.rejects(() => reconcileLinuxLocalIdentityContract({ ...NAMES, platform: 'linux', invoke: values.invoke }, { observe: values.observe }), /requires an established protected claim/u);
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-local-identity-reconciliation.js', import.meta.url)), 'utf8');
  for (const forbidden of ['systemctl', 'libvirt', 'qemu', 'polkit', 'virsh', 'ownership.json', 'refresh.json', 'reconcileProtectedAuthority']) {
    assert.equal(source.includes(forbidden), false, `identity reconciliation gained neighboring authority through ${forbidden}`);
  }
});
