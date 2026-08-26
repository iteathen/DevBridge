import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  handleWindowsLifecycleAuthorityWorkerRequest,
  parseWindowsLifecycleAuthorityWorkerArguments,
  runWindowsLifecycleAuthorityWorker,
} from '../src/entry/windows-lifecycle-authority-worker.mjs';
import {
  ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
  ENVIRONMENT_LIFECYCLE_AUTHORITY_RESULT_PROTOCOL,
} from '../src/runtime/environment-lifecycle-authority.js';
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
