import test from 'node:test';
import assert from 'node:assert/strict';
import {
  observeLinuxLocalIdentities,
  LINUX_LOCAL_IDENTITIES_PROTOCOL,
} from '../src/setup/linux-local-identities.js';

function result(exitCode, stdout = '', stderr = '') {
  return Object.freeze({ exitCode, stdout, stderr, timedOut: false, aborted: false, outputTruncated: false });
}

function fixture() {
  const calls = [];
  const records = new Map([
    ['getent passwd alice', result(0, 'alice:x:1000:1000:Alice:/home/alice:/bin/bash\n')],
    ['getent passwd db-auth', result(0, 'db-auth:x:995:994:DevBridge:/nonexistent:/usr/sbin/nologin\n')],
    ['getent group db-read', result(0, 'db-read:x:994:alice\n')],
    ['getent group db-coord', result(0, 'db-coord:x:993:db-auth,alice\n')],
    ['getent group provider-control', result(0, 'provider-control:x:108:db-auth\n')],
    ['id -G -- alice', result(0, '1000 994 993\n')],
    ['id -G -- db-auth', result(0, '994 993 108\n')],
  ]);
  const invoke = async (request) => {
    calls.push(request);
    const executable = request.executable === '/usr/bin/getent' ? 'getent' : request.executable === '/usr/bin/id' ? 'id' : request.executable;
    const key = [executable, ...request.arguments].join(' ');
    if (!records.has(key)) throw new Error(`unexpected invocation ${key}`);
    return records.get(key);
  };
  return { calls, records, invoke };
}

test('Linux local identity observation uses bounded NSS-aware lookups and numeric group evidence', async () => {
  const values = fixture();
  const observed = await observeLinuxLocalIdentities({
    accountNames: ['alice', 'db-auth'],
    groupNames: ['db-read', 'db-coord', 'provider-control'],
    platform: 'linux',
    invoke: values.invoke,
    environment: {},
  });
  assert.equal(observed.protocol, LINUX_LOCAL_IDENTITIES_PROTOCOL);
  assert.equal(observed.applicable, true);
  assert.deepEqual(observed.accounts[0], {
    name: 'alice',
    record: { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash' },
    groupIds: [993, 994, 1000],
  });
  assert.deepEqual(observed.accounts[1].groupIds, [108, 993, 994]);
  assert.equal(values.calls.every((call) => call.executable === '/usr/bin/getent' || call.executable === '/usr/bin/id'), true);
  assert.equal(values.calls.every((call) => !call.arguments.includes('start') && !call.arguments.includes('stop')), true);
});

test('missing identities remain explicit and do not trigger a group lookup', async () => {
  const calls = [];
  const observed = await observeLinuxLocalIdentities({
    accountNames: ['missing'],
    groupNames: ['missing-group'],
    platform: 'linux',
    invoke: async (request) => {
      calls.push(request);
      return result(2);
    },
    environment: {},
  });
  assert.equal(observed.accounts[0].record, null);
  assert.deepEqual(observed.accounts[0].groupIds, []);
  assert.equal(observed.groups[0].record, null);
  assert.equal(calls.length, 2);
});

test('NSS ambiguity, identity aliasing, and contradictory group sets fail closed', async () => {
  const ambiguous = fixture();
  ambiguous.records.set('getent passwd alice', result(0, 'alice:x:1000:1000:A:/home/alice:/bin/bash\nalice:x:1001:1001:B:/srv/alice:/bin/bash\n'));
  await assert.rejects(() => observeLinuxLocalIdentities({ accountNames: ['alice'], platform: 'linux', invoke: ambiguous.invoke }), /ambiguous/u);

  const alias = fixture();
  alias.records.set('getent group db-coord', result(0, 'db-coord:x:994:db-auth,alice\n'));
  await assert.rejects(() => observeLinuxLocalIdentities({
    accountNames: [],
    groupNames: ['db-read', 'db-coord'],
    platform: 'linux',
    invoke: alias.invoke,
  }), /alias one numeric group/u);

  const contradiction = fixture();
  contradiction.records.set('id -G -- db-auth', result(0, '993 108\n'));
  await assert.rejects(() => observeLinuxLocalIdentities({ accountNames: ['db-auth'], platform: 'linux', invoke: contradiction.invoke }), /contradictory/u);
});

test('non-Linux observation is explicitly unattached and performs no invocation', async () => {
  let invoked = false;
  const observed = await observeLinuxLocalIdentities({
    accountNames: ['alice'],
    groupNames: ['provider-control'],
    platform: 'win32',
    invoke: async () => { invoked = true; },
  });
  assert.equal(observed.applicable, false);
  assert.equal(invoked, false);
});

test('identity observation rejects unbounded or nonportable names before invocation', async () => {
  let invoked = false;
  const invoke = async () => { invoked = true; };
  await assert.rejects(() => observeLinuxLocalIdentities({ accountNames: ['alice.example'], platform: 'linux', invoke }), /entry is invalid/u);
  await assert.rejects(() => observeLinuxLocalIdentities({ groupNames: Array.from({ length: 17 }, (_, index) => `g${index}`), platform: 'linux', invoke }), /bounded array/u);
  await assert.rejects(() => observeLinuxLocalIdentities({ accountNames: ['alice', 'alice'], platform: 'linux', invoke }), /duplicate/u);
  assert.equal(invoked, false);
});
