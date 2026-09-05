import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
  LifecycleAuthorityClient,
  createLifecycleAuthorityMutationHandler,
  createLifecycleAuthorityReadHandler,
  environmentLifecycleAuthorityOperationIsReadOnly,
  normalizeLifecycleAuthorityRequest,
} from '../src/runtime/environment-lifecycle-authority.js';

const ENV = 'environment-test';

test('lifecycle protocol alone classifies replay-safe read capability operations', () => {
  for (const operation of ['inspect', 'list', 'status', 'plan', 'setup-reentry']) {
    assert.equal(environmentLifecycleAuthorityOperationIsReadOnly(operation), true, operation);
  }
  for (const operation of ['run', 'resume', '', null]) {
    assert.equal(environmentLifecycleAuthorityOperationIsReadOnly(operation), false, String(operation));
  }
});

function operatorFixture(calls) {
  return {
    async inspect() { calls.push(['inspect']); return { state: 'ready' }; },
    async list() { calls.push(['list']); return [{ environmentIdentity: ENV, recommendedAction: 'none' }]; },
    async status(identity) { calls.push(['status', identity]); return { environmentIdentity: identity, health: { state: 'ready' } }; },
    async plan(operation, identity) {
      calls.push(['plan', operation, identity]);
      return { operation, environmentIdentity: identity, destructive: ['rebuild','reset','recreate'].includes(operation), authorizationSubject: `${operation}-subject` };
    },
    async run(operation, identity, options) { calls.push(['run', operation, identity, options]); return { state: 'complete', operation, environmentIdentity: identity }; },
    async resume(identity, options) { calls.push(['resume', identity, options]); return { state: 'complete', environmentIdentity: identity }; },
    async setupReentry(identity) { calls.push(['setupReentry', identity]); return { action: 'setup-reentry', environmentIdentity: identity }; },
  };
}

test('authority client routes only the existing neutral environment operator stud', async () => {
  const calls = [];
  const operator = operatorFixture(calls);
  const client = new LifecycleAuthorityClient({
    readExchange: createLifecycleAuthorityReadHandler({ operator }),
    mutationExchange: createLifecycleAuthorityMutationHandler({ operator }),
  });

  await client.inspect();
  await client.status(ENV);
  const plan = await client.plan('reset', ENV);
  await client.setupReentry(ENV);
  await client.run('reset', ENV, { approval: plan.authorizationSubject });
  await client.resume(ENV, { approval: plan.authorizationSubject });

  assert.deepEqual(calls, [
    ['inspect'],
    ['status', ENV],
    ['plan', 'reset', ENV],
    ['setupReentry', ENV],
    ['run', 'reset', ENV, { approval: 'reset-subject' }],
    ['resume', ENV, { approval: 'reset-subject' }],
  ]);
});

test('read and mutation capabilities are separate authority endpoints', async () => {
  const calls = [];
  const operator = operatorFixture(calls);
  const read = createLifecycleAuthorityReadHandler({ operator });
  const mutation = createLifecycleAuthorityMutationHandler({ operator });
  const base = { protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL, requestId: '11111111-1111-4111-8111-111111111111' };

  const deniedMutation = await read({ ...base, operation: 'run', payload: { operation: 'reset', identity: ENV, approval: 'reset-subject' } });
  assert.equal(deniedMutation.ok, false);
  assert.equal(deniedMutation.error.code, 'OPERATION_NOT_ALLOWED');

  const deniedRead = await mutation({ ...base, operation: 'status', payload: { identity: ENV } });
  assert.equal(deniedRead.ok, false);
  assert.equal(deniedRead.error.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(calls.length, 0);
});

test('lower provider and PersistentEnvironments mutation methods are not remotely addressable', () => {
  const base = { protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL, requestId: '11111111-1111-4111-8111-111111111111' };
  for (const operation of ['ensure', 'observe', 'start', 'stop', 'remove', 'reconcile', 'reseed', 'replace', 'retire-superseded', 'shell']) {
    assert.throws(() => normalizeLifecycleAuthorityRequest({ ...base, operation, payload: {} }), /not allowed/u);
  }
});

test('authority protocol rejects path, command, provider and arbitrary-field smuggling before dispatch', () => {
  const base = { protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL, requestId: '11111111-1111-4111-8111-111111111111' };
  for (const [operation, payload] of [
    ['status', { identity: ENV, path: '/var/lib/libvirt/images/owned.qcow2' }],
    ['plan', { operation: 'reset', identity: ENV, vmName: 'db-env-dangerous' }],
    ['run', { operation: 'reset', identity: ENV, approval: 'reset-subject', command: 'Remove-VM' }],
    ['resume', { identity: ENV, argv: ['virsh', 'undefine'] }],
  ]) {
    assert.throws(() => normalizeLifecycleAuthorityRequest({ ...base, operation, payload }), /not allowed/u);
  }
  assert.throws(() => normalizeLifecycleAuthorityRequest({ ...base, operation: 'run', payload: { operation: 'remove', identity: ENV } }), /lifecycle operation is invalid/u);
});

test('authority handler fails closed on malformed requests without invoking operator', async () => {
  const calls = [];
  const handler = createLifecycleAuthorityMutationHandler({ operator: operatorFixture(calls) });
  const result = await handler({
    protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
    requestId: '11111111-1111-4111-8111-111111111111',
    operation: 'run',
    payload: { operation: 'reset', identity: ENV, executable: 'powershell.exe' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('authority result refuses host/provider detail and does not return raw provider failures', async () => {
  const calls = [];
  const operator = operatorFixture(calls);
  operator.status = async () => ({ environmentIdentity: ENV, path: 'C:\\private\\state.vhdx' });
  const client = new LifecycleAuthorityClient({
    readExchange: createLifecycleAuthorityReadHandler({ operator }),
    mutationExchange: createLifecycleAuthorityMutationHandler({ operator }),
  });
  await assert.rejects(client.status(ENV), (error) => error.code === 'OPERATION_FAILED');

  operator.status = async () => ({ environmentIdentity: ENV, detail: '/var/lib/libvirt/images/owned.qcow2' });
  await assert.rejects(client.status(ENV), (error) => error.code === 'OPERATION_FAILED');

  operator.status = async () => { throw new Error('Remove-VM failed for C:\\private\\state.vhdx'); };
  await assert.rejects(client.status(ENV), (error) => {
    assert.equal(error.code, 'OPERATION_FAILED');
    assert.equal(error.message.includes('C:\\private'), false);
    assert.equal(error.message.includes('Remove-VM'), false);
    return true;
  });
});

test('client treats exchange failure and response ownership mismatch as authority failure', async () => {
  const unavailable = new LifecycleAuthorityClient({
    readExchange: async () => { throw new Error('socket down'); },
    mutationExchange: async () => { throw new Error('socket down'); },
  });
  await assert.rejects(unavailable.status(ENV), (error) => {
    assert.equal(error.code, 'LIFECYCLE_AUTHORITY_UNAVAILABLE');
    assert.match(error.message, /authority is unavailable/u);
    assert.equal(error.message.includes('socket down'), false);
    return true;
  });

  const mismatchedExchange = async (request) => ({
    protocol: 'devbridge/environment-lifecycle-authority-result-v1',
    requestId: request.requestId.replace(/^./u, request.requestId[0] === '0' ? '1' : '0'),
    ok: true,
    value: {},
  });
  const mismatched = new LifecycleAuthorityClient({ readExchange: mismatchedExchange, mutationExchange: mismatchedExchange });
  await assert.rejects(mismatched.status(ENV), /ownership proof is invalid/u);
});
