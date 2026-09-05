import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_CONFIGURATION_AUTHORITY_REQUEST_PROTOCOL,
  ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL,
  EnvironmentConfigurationClient,
  createEnvironmentConfigurationHandler,
  normalizeEnvironmentConfigurationRequest,
  normalizeEnvironmentConfigurationResult,
} from '../src/runtime/environment-configuration-authority.js';

const requestId = '9a80e674-90f1-4ddd-8254-3cf4695bd66e';
const subject = 'a'.repeat(64);

function request(overrides = {}) {
  return {
    protocol: ENVIRONMENT_CONFIGURATION_AUTHORITY_REQUEST_PROTOCOL,
    requestId,
    operation: 'reconcile',
    payload: { revision: 7, subject },
    ...overrides,
  };
}

test('configuration request exposes only exact revision and subject data', () => {
  assert.deepEqual(normalizeEnvironmentConfigurationRequest(request()), request());
  assert.deepEqual(normalizeEnvironmentConfigurationRequest(request({ operation: 'inspect', payload: {} })), request({ operation: 'inspect', payload: {} }));
  for (const payload of [
    { revision: 7, subject, path: 'C:\\escape' },
    { revision: 7, subject, provider: 'hyperv' },
    { revision: 7, subject, command: 'anything' },
    { revision: 7, subject, credential: 'anything' },
  ]) {
    assert.throws(() => normalizeEnvironmentConfigurationRequest(request({ payload })), /not allowed/u);
  }
  assert.throws(() => normalizeEnvironmentConfigurationRequest(request({ operation: 'unknown' })), /operation is invalid/u);
  assert.throws(() => normalizeEnvironmentConfigurationRequest(request({ operation: 'inspect', payload: { revision: 7 } })), /not allowed/u);
  assert.throws(() => normalizeEnvironmentConfigurationRequest(request({ payload: { revision: 0, subject } })), /revision/u);
  assert.throws(() => normalizeEnvironmentConfigurationRequest(request({ payload: { revision: 7, subject: 'wrong' } })), /subject/u);
});

test('configuration result binds exact request identity and accepted subject', () => {
  const result = {
    protocol: ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL,
    requestId,
    ok: true,
    value: { ready: true, changed: true, revision: 7, subject },
  };
  assert.deepEqual(normalizeEnvironmentConfigurationResult(result, request()), result);
  assert.throws(() => normalizeEnvironmentConfigurationResult({ ...result, requestId: crypto.randomUUID() }, request()), /ownership proof/u);
  assert.throws(() => normalizeEnvironmentConfigurationResult({ ...result, value: { ...result.value, subject: 'b'.repeat(64) } }, request()), /subject changed/u);
  assert.throws(() => normalizeEnvironmentConfigurationResult({ ...result, value: { ...result.value, provider: 'hyperv' } }, request()), /not allowed/u);
  assert.throws(() => normalizeEnvironmentConfigurationResult({
    protocol: ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL,
    requestId,
    ok: false,
    error: { code: 'OPERATION_FAILED', message: 'x'.repeat(20 * 1024) },
  }, request()), /too large/u);
});

test('configuration handler dispatches one exact reconciliation and sanitizes failures', async () => {
  const calls = [];
  const handler = createEnvironmentConfigurationHandler({
    configuration: {
      async inspect() { return { ready: true }; },
      async reconcile(value) {
        calls.push(value);
        return { ready: true, changed: false, ...value };
      },
    },
  });
  const accepted = await handler(request());
  assert.deepEqual(calls, [{ revision: 7, subject }]);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.value, { ready: true, changed: false, revision: 7, subject });

  const rejected = await createEnvironmentConfigurationHandler({
    configuration: { async inspect() { return { ready: true }; }, async reconcile() { throw new Error('C:\\secret\\provider.vhdx'); } },
  })(request());
  assert.deepEqual(rejected.error, { code: 'OPERATION_FAILED', message: 'environment configuration operation failed' });
  assert.doesNotMatch(JSON.stringify(rejected), /secret|vhdx/u);
});

test('configuration client accepts only request-bound evidence and fails closed on absence', async () => {
  const client = new EnvironmentConfigurationClient({
    exchange: async (selected) => selected.operation === 'inspect'
      ? { protocol: ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL, requestId: selected.requestId, ok: true, value: { ready: true } }
      : {
        protocol: ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL,
        requestId: selected.requestId,
        ok: true,
        value: { ready: true, changed: true, ...selected.payload },
      },
  });
  assert.deepEqual(await client.inspect(), { ready: true });
  assert.deepEqual(await client.reconcile({ revision: 7, subject }), { ready: true, changed: true, revision: 7, subject });

  const absent = new EnvironmentConfigurationClient({ exchange: async () => { throw new Error('absent'); } });
  await assert.rejects(absent.reconcile({ revision: 7, subject }), (error) => error.code === 'ENVIRONMENT_CONFIGURATION_AUTHORITY_UNAVAILABLE');
});
