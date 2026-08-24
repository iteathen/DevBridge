import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
  LifecycleAuthorityClient,
  createLifecycleAuthorityHandler,
  normalizeLifecycleAuthorityRequest,
} from '../src/runtime/environment-lifecycle-authority.js';

const ENV = `env-${'a'.repeat(32)}`;
const NEXT = `env-${'b'.repeat(32)}`;

function lifecycleFixture(calls) {
  const methods = ['ensure', 'list', 'observe', 'start', 'stop', 'reset', 'reseed', 'remove', 'reconcile', 'protectedSourceIdentities', 'rebuild', 'replace', 'recreate', 'retireSuperseded'];
  return Object.fromEntries(methods.map((name) => [name, async (...args) => {
    calls.push([name, ...args]);
    return name === 'protectedSourceIdentities' ? ['base-linux'] : { operation: name, identity: args[0]?.identity ?? args[0] ?? ENV };
  }]));
}

test('authority client routes the existing lifecycle stud without provider-native inputs', async () => {
  const calls = [];
  const handler = createLifecycleAuthorityHandler({ lifecycle: lifecycleFixture(calls) });
  const client = new LifecycleAuthorityClient({ exchange: handler });

  await client.ensure({ subject: 'profile:linux', profile: 'linux', sourceIdentity: 'base-linux', settings: { memoryBytes: 1073741824, processorCount: 2, firmware: 'efi' } });
  await client.stop(ENV, { force: true, timeoutMs: 12_000 });
  await client.rebuild(ENV, { requestId: 'rebuild-1', expectedPreviousIdentity: ENV });
  await client.retireSuperseded(NEXT, { supersededIdentity: ENV });

  assert.deepEqual(calls[0], ['ensure', {
    subject: 'profile:linux',
    profile: 'linux',
    sourceIdentity: 'base-linux',
    settings: { memoryBytes: 1073741824, processorCount: 2, firmware: 'efi' },
  }]);
  assert.deepEqual(calls[1], ['stop', ENV, { force: true, timeoutMs: 12_000 }]);
  assert.deepEqual(calls[2], ['rebuild', ENV, { requestId: 'rebuild-1', expectedPreviousIdentity: ENV }]);
  assert.deepEqual(calls[3], ['retireSuperseded', NEXT, { supersededIdentity: ENV }]);
});

test('authority protocol rejects path, command, provider and arbitrary-field smuggling before dispatch', () => {
  const base = { protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL, requestId: '11111111-1111-4111-8111-111111111111' };
  for (const [operation, payload] of [
    ['observe', { identity: ENV, path: '/var/lib/libvirt/images/owned.qcow2' }],
    ['start', { identity: ENV, vmName: 'db-env-dangerous' }],
    ['stop', { identity: ENV, command: 'Remove-VM', force: false }],
    ['ensure', { subject: 'profile:linux', profile: 'linux', sourceIdentity: 'base-linux', settings: {}, location: 'C:\\vm\\disk.vhdx' }],
    ['rebuild', { identity: ENV, requestId: 'rebuild-1', expectedPreviousIdentity: ENV, argv: ['virsh', 'undefine'] }],
  ]) {
    assert.throws(() => normalizeLifecycleAuthorityRequest({ ...base, operation, payload }), /not allowed/u);
  }
  assert.throws(() => normalizeLifecycleAuthorityRequest({ ...base, operation: 'shell', payload: {} }), /not allowed/u);
});

test('authority handler fails closed on malformed requests without invoking lifecycle', async () => {
  const calls = [];
  const handler = createLifecycleAuthorityHandler({ lifecycle: lifecycleFixture(calls) });
  const result = await handler({
    protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
    requestId: '11111111-1111-4111-8111-111111111111',
    operation: 'remove',
    payload: { identity: ENV, executable: 'powershell.exe' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('authority result refuses provider authority detail and does not return raw provider errors', async () => {
  const calls = [];
  const lifecycle = lifecycleFixture(calls);
  lifecycle.observe = async () => ({ identity: ENV, exists: true, path: 'C:\\private\\state.vhdx' });
  const client = new LifecycleAuthorityClient({ exchange: createLifecycleAuthorityHandler({ lifecycle }) });
  await assert.rejects(client.observe(ENV), (error) => error.code === 'OPERATION_FAILED' && /authority operation failed/u.test(error.message));

  lifecycle.observe = async () => { throw new Error('Remove-VM failed for C:\\private\\state.vhdx'); };
  await assert.rejects(client.observe(ENV), (error) => {
    assert.equal(error.code, 'OPERATION_FAILED');
    assert.equal(error.message.includes('C:\\private'), false);
    assert.equal(error.message.includes('Remove-VM'), false);
    return true;
  });
});

test('client treats exchange failure and response ownership mismatch as authority failure', async () => {
  const unavailable = new LifecycleAuthorityClient({ exchange: async () => { throw new Error('socket down'); } });
  await assert.rejects(unavailable.observe(ENV), /authority is unavailable/u);

  const mismatched = new LifecycleAuthorityClient({ exchange: async (request) => ({
    protocol: 'devbridge/environment-lifecycle-authority-result-v1',
    requestId: request.requestId.replace(/^./u, request.requestId[0] === '0' ? '1' : '0'),
    ok: true,
    value: {},
  }) });
  await assert.rejects(mismatched.observe(ENV), /ownership proof is invalid/u);
});
