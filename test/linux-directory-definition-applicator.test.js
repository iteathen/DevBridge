import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  applyLinuxDirectoryDefinition,
  LINUX_DIRECTORY_DEFINITION_APPLICATOR_PROTOCOL,
} from '../src/setup/linux-directory-definition-applicator.js';

const PATH = '/etc/tmpfiles.d/devbridge-local-123.conf';

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

test('Linux adapter applies one exact local directory definition with fixed mechanics', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const result = await applyLinuxDirectoryDefinition({ path: PATH, platform: 'linux', signal }, {
    invoke: async (request) => { calls.push(request); return success(); },
  });
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    executable: '/usr/bin/systemd-tmpfiles',
    arguments: ['--create', PATH],
    input: null,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
    environment: { LANG: 'C', LC_ALL: 'C' },
    signal,
  });
});

test('invalid or widened definitions fail before invocation', async () => {
  let invoked = false;
  const invoke = async () => { invoked = true; return success(); };
  for (const value of [
    '/tmp/devbridge.conf',
    '/etc/tmpfiles.d/../devbridge.conf',
    '/etc/tmpfiles.d/devbridge.service',
    '/etc/tmpfiles.d/devbridge helper.conf',
    '/etc/tmpfiles.d/.conf',
  ]) {
    await assert.rejects(() => applyLinuxDirectoryDefinition({ path: value, platform: 'linux' }, { invoke }), /path is invalid/u);
  }
  await assert.rejects(() => applyLinuxDirectoryDefinition({ path: PATH, platform: 'linux', executable: '/tmp/tool' }, { invoke }), /unknown field/u);
  await assert.rejects(() => applyLinuxDirectoryDefinition({ path: PATH, platform: 'linux', signal: {} }, { invoke }), /cancellation signal is invalid/u);
  await assert.rejects(() => applyLinuxDirectoryDefinition({ path: PATH, platform: 'linux' }, { invoke, extra: true }), /unknown field/u);
  assert.equal(invoked, false);
});

test('non-Linux adapter is explicitly inapplicable and invokes no ports', async () => {
  let invoked = false;
  const result = await applyLinuxDirectoryDefinition({ path: '../ignored', platform: 'win32' }, {
    invoke: async () => { invoked = true; return success(); },
  });
  assert.deepEqual(result, { protocol: LINUX_DIRECTORY_DEFINITION_APPLICATOR_PROTOCOL, platform: 'win32', applicable: false });
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
    await assert.rejects(
      () => applyLinuxDirectoryDefinition({ path: PATH, platform: 'linux' }, { invoke }),
      (error) => error.message === 'Linux directory definition application failed' && !error.message.includes('private'),
    );
  }
});

test('directory adapter contains no neighboring topology or authority', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-directory-definition-applicator.js', import.meta.url)), 'utf8');
  for (const forbidden of ['lifecycle', 'ownership', 'provider', 'repository', 'virtualMachine', 'libvirt', 'qemu', 'qcow2', 'sudo', 'pkexec', 'plan']) {
    assert.equal(source.includes(forbidden), false, `directory adapter gained neighboring authority through ${forbidden}`);
  }
});
