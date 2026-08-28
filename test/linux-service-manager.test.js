import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  LINUX_SERVICE_MANAGER_PROTOCOL,
  createLinuxServiceManager,
} from '../src/setup/linux-service-manager.js';

const UNIT = 'devbridge-authority-123456789abc.service';

function success(overrides = {}) {
  return Object.freeze({
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: '',
    stderr: '',
    ...overrides,
  });
}

test('Linux adapter maps neutral actions to exact fixed system-manager invocations', async () => {
  const calls = [];
  const signals = [];
  const signal = new AbortController().signal;
  const manager = createLinuxServiceManager({
    unit: UNIT,
    platform: 'linux',
    signal,
    invoke: async (request) => {
      signals.push(request.signal);
      calls.push(structuredClone({ ...request, signal: undefined }));
      return success();
    },
  });
  assert.equal(manager.protocol, LINUX_SERVICE_MANAGER_PROTOCOL);
  assert.equal(manager.applicable, true);
  assert.equal(await manager.refresh(), true);
  assert.equal(await manager.persist(), true);
  assert.equal(await manager.quiesce(), true);
  assert.equal(await manager.activate(), true);
  assert.deepEqual(calls.map((entry) => entry.arguments), [
    ['--system', '--no-pager', '--no-ask-password', 'daemon-reload'],
    ['--system', '--no-pager', '--no-ask-password', 'enable', UNIT],
    ['--system', '--no-pager', '--no-ask-password', 'stop', UNIT],
    ['--system', '--no-pager', '--no-ask-password', 'start', UNIT],
  ]);
  assert.equal(signals.every((entry) => entry === signal), true);
  for (const call of calls) {
    assert.equal(call.executable, '/usr/bin/systemctl');
    assert.equal(call.input, null);
    assert.equal(call.timeoutMs, 30_000);
    assert.equal(call.maxOutputBytes, 16 * 1024);
    assert.deepEqual(call.environment, { LANG: 'C', LC_ALL: 'C' });
  }
});

test('invalid or widened Linux requests fail before invocation', () => {
  let invoked = false;
  const invoke = async () => { invoked = true; return success(); };
  for (const unit of ['devbridge.service/other', '../devbridge.service', 'devbridge', '.service', 'devbridge helper.service', `${'a'.repeat(128)}.service`]) {
    assert.throws(() => createLinuxServiceManager({ unit, platform: 'linux', invoke }), /unit is invalid/u);
  }
  assert.throws(() => createLinuxServiceManager({ unit: UNIT, platform: 'linux', invoke, executable: '/tmp/tool' }), /unknown field/u);
  assert.throws(() => createLinuxServiceManager({ unit: UNIT, platform: 'linux', invoke, signal: {} }), /cancellation signal is invalid/u);
  assert.equal(invoked, false);
});

test('non-Linux adapter is explicitly inapplicable and performs no invocation', () => {
  let invoked = false;
  const manager = createLinuxServiceManager({
    unit: '../ignored',
    platform: 'win32',
    invoke: async () => { invoked = true; return success(); },
  });
  assert.deepEqual(manager, { protocol: LINUX_SERVICE_MANAGER_PROTOCOL, platform: 'win32', applicable: false });
  assert.equal(invoked, false);
});

test('all invocation failures are bounded and disclose no command output', async () => {
  const cases = [
    async () => success({ exitCode: 1, stderr: 'private path /secret' }),
    async () => success({ timedOut: true }),
    async () => success({ aborted: true }),
    async () => success({ outputTruncated: true }),
    async () => { throw new Error('spawn leaked /private'); },
  ];
  for (const invoke of cases) {
    const manager = createLinuxServiceManager({ unit: UNIT, platform: 'linux', invoke });
    await assert.rejects(
      () => manager.activate(),
      (error) => error.message === 'Linux service manager activation failed' && !error.message.includes('private'),
    );
  }
});

test('Linux adapter contains no neighboring lifecycle or machine topology', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-service-manager.js', import.meta.url)), 'utf8');
  for (const forbidden of ['reconcileDefinition', 'ownership', 'provider', 'repository', 'virtualMachine', 'libvirt', 'qemu', 'qcow2', 'sudo', 'pkexec', 'plan']) {
    assert.equal(source.includes(forbidden), false, `Linux service adapter gained neighboring authority through ${forbidden}`);
  }
});
