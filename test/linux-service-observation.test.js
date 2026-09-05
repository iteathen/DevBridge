import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  LINUX_SERVICE_OBSERVATION_PROTOCOL,
  observeLinuxService,
} from '../src/setup/linux-service-observation.js';

const UNIT = 'devbridge-authority-123456789abc.service';

function output({ reload = 'no', dropIns = '', loadState = 'loaded', unitFileState = 'enabled' } = {}) {
  const exists = loadState !== 'not-found';
  return [
    `LoadState=${loadState}`,
    `ActiveState=${exists ? 'active' : 'inactive'}`,
    `SubState=${exists ? 'running' : 'dead'}`,
    `MainPID=${exists ? '4242' : '0'}`,
    `FragmentPath=${exists ? `/etc/systemd/system/${UNIT}` : ''}`,
    `User=${exists ? 'service_user' : ''}`,
    `Group=${exists ? 'service_read' : ''}`,
    `SupplementaryGroups=${exists ? 'service_coord 108' : ''}`,
    `Type=${exists ? 'exec' : ''}`,
    `UnitFileState=${unitFileState}`,
    `NeedDaemonReload=${reload}`,
    `DropInPaths=${dropIns}`,
    '',
  ].join('\n');
}

function success(stdout = output(), overrides = {}) {
  return Object.freeze({ exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '', ...overrides });
}

test('read-only observer invokes one fixed bounded system-manager query', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const observed = await observeLinuxService({ unit: UNIT, platform: 'linux', signal }, {
    invoke: async (request) => { calls.push(request); return success(); },
  });
  assert.equal(observed.protocol, LINUX_SERVICE_OBSERVATION_PROTOCOL);
  assert.equal(observed.observable, true);
  assert.equal(observed.exists, true);
  assert.equal(observed.definitionCurrent, true);
  assert.equal(observed.needsReload, false);
  assert.equal(observed.dropIns, false);
  assert.deepEqual(observed.supplementaryGroups, ['service_coord', '108']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, '/usr/bin/systemctl');
  assert.deepEqual(calls[0].arguments.slice(0, 5), ['--system', '--no-pager', '--no-ask-password', 'show', UNIT]);
  assert.equal(calls[0].arguments.filter((entry) => entry.startsWith('--property=')).length, 12);
  assert.equal(calls[0].input, null);
  assert.equal(calls[0].timeoutMs, 15_000);
  assert.equal(calls[0].maxOutputBytes, 32 * 1024);
  assert.deepEqual(calls[0].environment, { LANG: 'C', LC_ALL: 'C' });
  assert.equal(calls[0].signal, signal);
});

test('reload and drop-in facts independently prevent current-definition evidence', async () => {
  for (const selected of [
    { reload: 'yes', dropIns: '' },
    { reload: 'no', dropIns: '/etc/systemd/system/example.service.d/override.conf' },
  ]) {
    const observed = await observeLinuxService({ unit: UNIT, platform: 'linux' }, { invoke: async () => success(output(selected)) });
    assert.equal(observed.observable, true);
    assert.equal(observed.definitionCurrent, false);
    assert.equal(observed.needsReload, selected.reload === 'yes');
    assert.equal(observed.dropIns, selected.dropIns.length > 0);
  }
});

test('missing units remain observable with independent empty persistence evidence', async () => {
  const observed = await observeLinuxService({ unit: UNIT, platform: 'linux' }, {
    invoke: async () => success(output({ loadState: 'not-found', unitFileState: '' })),
  });
  assert.equal(observed.observable, true);
  assert.equal(observed.exists, false);
  assert.equal(observed.unitFileState, '');
});

test('failed, malformed, and widened observations remain bounded', async () => {
  for (const invoke of [
    async () => success('', { exitCode: 1, stderr: '/private/path' }),
    async () => success(output(), { timedOut: true }),
    async () => success(output(), { outputTruncated: true }),
    async () => success('LoadState=loaded\n'),
    async () => { throw new Error('/private/spawn'); },
  ]) {
    const observed = await observeLinuxService({ unit: UNIT, platform: 'linux' }, { invoke });
    assert.equal(observed.observable, false);
    assert.equal(observed.reason.includes('private'), false);
  }
  await assert.rejects(
    () => observeLinuxService({ unit: UNIT, platform: 'linux' }, { invoke: async () => success(), provider: () => {} }),
    /unknown field/u,
  );
  const oversizedGroup = await observeLinuxService({ unit: UNIT, platform: 'linux' }, {
    invoke: async () => success(output().replace('SupplementaryGroups=service_coord 108', 'SupplementaryGroups=service_coord 4294967295')),
  });
  assert.equal(oversizedGroup.observable, false);
  assert.equal(oversizedGroup.reason, 'service manager observation invalid');
});

test('invalid names fail and non-Linux observation invokes nothing', async () => {
  let invoked = false;
  await assert.rejects(
    () => observeLinuxService({ unit: '../bad.service', platform: 'linux' }, { invoke: async () => { invoked = true; return success(); } }),
    /unit is invalid/u,
  );
  const observed = await observeLinuxService({ unit: '../unused', platform: 'win32' }, {
    invoke: async () => { invoked = true; return success(); },
  });
  assert.equal(observed.applicable, false);
  assert.equal(invoked, false);
});

test('observer source contains no mutation or neighboring topology', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-service-observation.js', import.meta.url)), 'utf8');
  for (const forbidden of ['daemon-reload', 'ownership', 'lifecycle', 'provider', 'repository', 'virtualMachine', 'libvirt', 'qemu', 'sudo', 'pkexec']) {
    assert.equal(source.includes(forbidden), false, `service observer gained foreign authority through ${forbidden}`);
  }
  assert.equal(/['"](?:start|stop|enable)['"]/u.test(source), false, 'service observer gained a mutating command');
});
