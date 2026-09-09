import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import {
  handleWindowsLifecycleAuthorityWorkerRequest,
  parseWindowsLifecycleAuthorityWorkerArguments,
  runWindowsLifecycleAuthorityWorker,
  runWindowsActivityAuthorityStream,
} from '../src/entry/windows-lifecycle-authority-worker.mjs';

test('activity stream composes once, preserves request identities and closes its resources on EOF', async () => {
  const input = new PassThrough();
  let factoryCalls = 0, closes = 0;
  const responses = [];
  let delivered;
  const task = runWindowsActivityAuthorityStream({ input,
    output: { write(value) { responses.push(JSON.parse(value)); delivered?.(); } },
    activityFactory: async () => { factoryCalls++; return {
      inspect: async () => ({ ready: true, identity: 'a'.repeat(32), reason: null }),
      list: async () => [], observe: async () => {}, prepare: async () => {}, exchange: async () => {},
      close() { closes++; },
    }; },
  });
  for (let i = 1; i <= 2; i++) {
    const response = new Promise(resolve => { delivered = resolve; });
    input.write(JSON.stringify({ protocol: 'devbridge/environment-activity-authority-request-v1',
      requestId: `00000000-0000-4000-8000-00000000000${i}`, operation: 'inspect', payload: {} }) + '\n');
    await response;
  }
  input.end(); await task;
  assert.equal(factoryCalls, 1); assert.equal(closes, 1);
  assert.equal(responses.length, 2); assert.notEqual(responses[0].requestId, responses[1].requestId);
  assert.equal(responses.every(value => value.ok), true);
});

test('activity stream rejects oversized and unsolicited framing before composing authority', async () => {
  for (const wire of ['{}\n{}\n', 'x'.repeat(70 * 1024), '{"truncated":']) {
    let calls = 0;
    await assert.rejects(runWindowsActivityAuthorityStream({ input: Readable.from([wire]), output: { write() {} },
      activityFactory: async () => { calls++; },
    }), /framing|bound|interrupted/);
    assert.equal(calls, 0);
  }
  const input = new PassThrough();
  await assert.rejects(runWindowsActivityAuthorityStream({ input, output: { write() {} }, activityFactory: async () => {}, idleMs: 10 }), /idle lifetime/);
});
import {
  ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
  ENVIRONMENT_LIFECYCLE_AUTHORITY_RESULT_PROTOCOL,
} from '../src/runtime/environment-lifecycle-authority.js';
import {
  ENVIRONMENT_ACTIVITY_AUTHORITY_REQUEST_PROTOCOL,
  ENVIRONMENT_ACTIVITY_AUTHORITY_RESULT_PROTOCOL,
} from '../src/runtime/environment-activity-authority.js';
import {
  ENVIRONMENT_CONFIGURATION_AUTHORITY_REQUEST_PROTOCOL,
  ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL,
} from '../src/runtime/environment-configuration-authority.js';
import {
  WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_REQUEST_PROTOCOL,
  WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_RESULT_PROTOCOL,
} from '../src/setup/windows-lifecycle-authority-acceptance.js';

const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const AUTHORITY = 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\state';
const ENV = 'environment-test';

function request(operation, payload = {}) {
  return {
    protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
    requestId: '00000000-0000-4000-8000-000000000001',
    operation,
    payload,
  };
}

function operator(calls) {
  return {
    async inspect() { calls.push(['inspect']); return { state: 'ready' }; },
    async list() { calls.push(['list']); return []; },
    async status(identity) { calls.push(['status', identity]); return { environmentIdentity: identity }; },
    async plan(operation, identity) { calls.push(['plan', operation, identity]); return { authorizationSubject: 'approval' }; },
    async run(operation, identity, options) { calls.push(['run', operation, identity, options]); return { state: 'complete' }; },
    async resume(identity, options) { calls.push(['resume', identity, options]); return { state: 'complete' }; },
    async setupReentry(identity) { calls.push(['setupReentry', identity]); return { action: 'setup-reentry' }; },
  };
}

test('worker returns request-bound path-free initialization failure evidence instead of dropping the pipe response', async () => {
  const selected = request('inspect');
  let wire = '';
  const failure = new Error('access denied at C:\\protected\\secret');
  failure.code = 'EACCES';
  await runWindowsLifecycleAuthorityWorker({
    argv: ['--access', 'read', '--state-directory', STATE, '--authority-directory', AUTHORITY],
    input: Readable.from([`${JSON.stringify(selected)}\n`]),
    output: { write(value) { wire += String(value); } },
    operatorFactory: async () => { throw failure; },
  });
  const response = JSON.parse(wire);
  assert.equal(response.protocol, ENVIRONMENT_LIFECYCLE_AUTHORITY_RESULT_PROTOCOL);
  assert.equal(response.requestId, selected.requestId);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'WORKER_INITIALIZATION_FAILED');
  assert.equal(response.error.message, 'environment lifecycle authority worker initialization failed (EACCES)');
  assert.doesNotMatch(wire, /protected|secret|C:\\/iu);
});

test('worker accepts only fixed access and protected state arguments', () => {
  assert.deepEqual(parseWindowsLifecycleAuthorityWorkerArguments([
    '--access', 'mutation',
    '--state-directory', STATE,
    '--authority-directory', AUTHORITY,
  ]), {
    access: 'mutation',
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
  });
  assert.deepEqual(parseWindowsLifecycleAuthorityWorkerArguments([
    '--access', 'acceptance',
    '--state-directory', STATE,
    '--authority-directory', AUTHORITY,
  ]), {
    access: 'acceptance',
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
  });
  assert.deepEqual(parseWindowsLifecycleAuthorityWorkerArguments([
    '--access', 'activity',
    '--state-directory', STATE,
    '--authority-directory', AUTHORITY,
  ]), {
    access: 'activity',
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
  });
  assert.deepEqual(parseWindowsLifecycleAuthorityWorkerArguments([
    '--access', 'configuration',
    '--state-directory', STATE,
    '--authority-directory', AUTHORITY,
  ]), {
    access: 'configuration',
    stateDirectory: STATE,
    authorityDirectory: AUTHORITY,
  });
  assert.throws(() => parseWindowsLifecycleAuthorityWorkerArguments([
    '--access', 'mutation',
    '--state-directory', STATE,
    '--authority-directory', AUTHORITY,
    '--command', 'Remove-VM',
  ]), /arguments are invalid/u);
  assert.throws(() => parseWindowsLifecycleAuthorityWorkerArguments([
    '--access', 'provider',
    '--state-directory', STATE,
    '--authority-directory', AUTHORITY,
  ]), /access class is invalid/u);
  assert.throws(() => parseWindowsLifecycleAuthorityWorkerArguments([
    '--access', 'read',
    '--state-directory', '/tmp/state',
    '--authority-directory', AUTHORITY,
  ]), /absolute Windows path/u);
});

test('worker preserves read versus mutation capability separation around one operator contract', async () => {
  const calls = [];
  const local = operator(calls);

  const read = await handleWindowsLifecycleAuthorityWorkerRequest({
    access: 'read',
    operator: local,
    request: request('status', { identity: ENV }),
  });
  assert.equal(read.ok, true);
  assert.deepEqual(calls, [['status', ENV]]);

  const deniedMutation = await handleWindowsLifecycleAuthorityWorkerRequest({
    access: 'read',
    operator: local,
    request: request('run', { operation: 'repair', identity: ENV, approval: null }),
  });
  assert.equal(deniedMutation.ok, false);
  assert.equal(deniedMutation.error.code, 'OPERATION_NOT_ALLOWED');
  assert.deepEqual(calls, [['status', ENV]]);

  const mutation = await handleWindowsLifecycleAuthorityWorkerRequest({
    access: 'mutation',
    operator: local,
    request: request('run', { operation: 'repair', identity: ENV, approval: 'approval' }),
  });
  assert.equal(mutation.ok, true);
  assert.deepEqual(calls.at(-1), ['run', 'repair', ENV, { approval: 'approval' }]);

  const deniedRead = await handleWindowsLifecycleAuthorityWorkerRequest({
    access: 'mutation',
    operator: local,
    request: request('status', { identity: ENV }),
  });
  assert.equal(deniedRead.ok, false);
  assert.equal(deniedRead.error.code, 'OPERATION_NOT_ALLOWED');
});

test('worker routes acceptance access only to the closed acceptance handler', async () => {
  const calls = [];
  const local = new Proxy(operator(calls), {
    get() { throw new Error('normal environment operator must not be reachable from acceptance access'); },
  });
  const selected = {
    protocol: WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_REQUEST_PROTOCOL,
    requestId: '00000000-0000-4000-8000-000000000002',
    operation: 'exercise',
  };
  let received = null;
  const response = await handleWindowsLifecycleAuthorityWorkerRequest({
    access: 'acceptance',
    operator: local,
    request: selected,
    authorityDirectory: AUTHORITY,
  }, {
    acceptanceHandler: async (input) => {
      received = input;
      return {
        protocol: WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_RESULT_PROTOCOL,
        requestId: selected.requestId,
        ok: true,
        value: { ready: true, generation: `acceptance-${'a'.repeat(32)}` },
      };
    },
  });
  assert.deepEqual(received, { request: selected, authorityDirectory: AUTHORITY });
  assert.equal(response.ok, true);
  assert.deepEqual(calls, []);
});

test('worker routes activity access only to the neutral activity contract', async () => {
  const selected = {
    protocol: ENVIRONMENT_ACTIVITY_AUTHORITY_REQUEST_PROTOCOL,
    requestId: '00000000-0000-4000-8000-000000000003',
    operation: 'inspect',
    payload: {},
  };
  const response = await handleWindowsLifecycleAuthorityWorkerRequest({
    access: 'activity',
    activity: {
      inspect: async () => ({ ready: true, identity: 'a'.repeat(32) }),
      list: async () => [],
      observe: async () => { throw new Error('unexpected'); },
      prepare: async () => { throw new Error('unexpected'); },
      exchange: async () => { throw new Error('unexpected'); },
    },
    request: selected,
  });
  assert.equal(response.protocol, ENVIRONMENT_ACTIVITY_AUTHORITY_RESULT_PROTOCOL);
  assert.equal(response.requestId, selected.requestId);
  assert.equal(response.ok, true);
  assert.deepEqual(response.value, { ready: true, identity: 'a'.repeat(32), reason: null });
});

test('activity worker initialization failures use the activity response contract', async () => {
  const selected = {
    protocol: ENVIRONMENT_ACTIVITY_AUTHORITY_REQUEST_PROTOCOL,
    requestId: '00000000-0000-4000-8000-000000000004',
    operation: 'inspect',
    payload: {},
  };
  let wire = '';
  await runWindowsLifecycleAuthorityWorker({
    argv: ['--access', 'activity', '--state-directory', STATE, '--authority-directory', AUTHORITY],
    input: Readable.from([`${JSON.stringify(selected)}\n`]),
    output: { write(value) { wire += String(value); } },
    activityFactory: async () => { throw new Error('C:\\protected\\detail'); },
  });
  const response = JSON.parse(wire);
  assert.equal(response.protocol, ENVIRONMENT_ACTIVITY_AUTHORITY_RESULT_PROTOCOL);
  assert.equal(response.requestId, selected.requestId);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'WORKER_INITIALIZATION_FAILED');
  assert.doesNotMatch(wire, /protected|C:\\/iu);
});

test('worker routes configuration access only to the exact configuration contract', async () => {
  const selected = {
    protocol: ENVIRONMENT_CONFIGURATION_AUTHORITY_REQUEST_PROTOCOL,
    requestId: '00000000-0000-4000-8000-000000000005',
    operation: 'reconcile',
    payload: { revision: 3, subject: 'b'.repeat(64) },
  };
  const calls = [];
  const response = await handleWindowsLifecycleAuthorityWorkerRequest({
    access: 'configuration',
    configuration: {
      async inspect() { return { ready: true }; },
      async reconcile(value) {
        calls.push(value);
        return { ready: true, changed: true, revision: value.revision, subject: value.subject };
      },
    },
    request: selected,
  });
  assert.equal(response.protocol, ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL);
  assert.equal(response.requestId, selected.requestId);
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{ revision: 3, subject: 'b'.repeat(64) }]);
});

test('configuration worker initialization failures use the configuration response contract', async () => {
  const selected = {
    protocol: ENVIRONMENT_CONFIGURATION_AUTHORITY_REQUEST_PROTOCOL,
    requestId: '00000000-0000-4000-8000-000000000006',
    operation: 'reconcile',
    payload: { revision: 3, subject: 'c'.repeat(64) },
  };
  let wire = '';
  await runWindowsLifecycleAuthorityWorker({
    argv: ['--access', 'configuration', '--state-directory', STATE, '--authority-directory', AUTHORITY],
    input: Readable.from([`${JSON.stringify(selected)}\n`]),
    output: { write(value) { wire += String(value); } },
    configurationFactory: async () => { throw new Error('C:\\protected\\detail'); },
  });
  const response = JSON.parse(wire);
  assert.equal(response.protocol, ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL);
  assert.equal(response.requestId, selected.requestId);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'WORKER_INITIALIZATION_FAILED');
  assert.doesNotMatch(wire, /protected|C:\\/iu);
});
