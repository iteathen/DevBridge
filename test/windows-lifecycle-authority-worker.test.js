import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleWindowsLifecycleAuthorityWorkerRequest,
  parseWindowsLifecycleAuthorityWorkerArguments,
} from '../src/entry/windows-lifecycle-authority-worker.mjs';
import { ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL } from '../src/runtime/environment-lifecycle-authority.js';

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
