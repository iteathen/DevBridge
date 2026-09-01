import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_ACTIVITY_AUTHORITY_REQUEST_PROTOCOL,
  EnvironmentActivityClient,
  createEnvironmentActivityHandler,
  environmentActivityOperationIsReadOnly,
  normalizeEnvironmentActivityRequest,
} from '../src/runtime/environment-activity-authority.js';
import { ENVIRONMENT_BRIDGE_PROTOCOL, EnvironmentBridge } from '../src/runtime/environment-bridge.js';

const TARGET = 'environment-logical';

test('activity protocol alone classifies replay-safe read operations', () => {
  for (const operation of ['inspect', 'list', 'observe']) {
    assert.equal(environmentActivityOperationIsReadOnly(operation), true, operation);
  }
  for (const operation of ['prepare', 'exchange', '', null]) {
    assert.equal(environmentActivityOperationIsReadOnly(operation), false, String(operation));
  }
});

function observed() {
  return {
    record: { identity: TARGET, subject: '42', profile: 'linux-development', provider: 'must-not-cross' },
    observation: { identity: TARGET, exists: true, owned: true, compatible: true, state: 'running', reason: null, storage: 'must-not-cross' },
  };
}

function bridgeResponse(frame, body) {
  return {
    protocol: ENVIRONMENT_BRIDGE_PROTOCOL,
    request: frame.request,
    target: frame.target,
    kind: frame.kind,
    ok: true,
    body,
  };
}

test('activity request vocabulary is bounded and rejects authority-bearing fields', () => {
  const base = { protocol: ENVIRONMENT_ACTIVITY_AUTHORITY_REQUEST_PROTOCOL, requestId: crypto.randomUUID(), operation: 'observe', payload: { target: TARGET } };
  assert.equal(normalizeEnvironmentActivityRequest(base).payload.target, TARGET);
  for (const [name, value] of [['provider', 'hyperv'], ['path', 'C:/protected'], ['command', 'Remove-VM']]) {
    assert.throws(() => normalizeEnvironmentActivityRequest({ ...base, payload: { ...base.payload, [name]: value } }), new RegExp(`${name} is not allowed`, 'u'));
  }
});

test('activity handler projects only neutral observation and preparation evidence', async () => {
  const activity = {
    async inspect() { return { ready: true, identity: 'foundation-a', provider: 'must-not-cross' }; },
    async list() { return [observed()]; },
    async observe(target) { assert.equal(target, TARGET); return observed(); },
    async prepare(target) { assert.equal(target, TARGET); return { generation: 'bootstrap-v1', connection: { identityFile: 'C:/secret' } }; },
    async exchange() { throw new Error('unexpected'); },
  };
  const handler = createEnvironmentActivityHandler({ activity });
  const client = new EnvironmentActivityClient({ exchange: handler });
  assert.deepEqual(await client.inspect(), { ready: true, identity: 'foundation-a', reason: null });
  assert.deepEqual(await client.list(), [{
    record: { identity: TARGET, subject: '42', profile: 'linux-development' },
    observation: { identity: TARGET, exists: true, owned: true, compatible: true, state: 'running', reason: null },
  }]);
  assert.deepEqual(await client.observe(TARGET), (await client.list())[0]);
  assert.deepEqual(await client.prepare(TARGET), { generation: 'bootstrap-v1' });
});

test('activity bridge client preserves the existing frame contract through the capability', async () => {
  const seen = [];
  const handler = createEnvironmentActivityHandler({ activity: {
    async inspect() { return { ready: true, identity: 'foundation-a' }; },
    async list() { return [observed()]; },
    async observe() { return observed(); },
    async prepare() { return { generation: 'bootstrap-v1' }; },
    async exchange(frame) {
      seen.push(frame);
      if (frame.kind === 'health') return bridgeResponse(frame, { version: '1.0.0', features: ['health', 'execute', 'observe', 'cancel', 'put', 'get'] });
      throw new Error('unexpected');
    },
  } });
  const client = new EnvironmentActivityClient({ exchange: handler });
  const bridge = new EnvironmentBridge({ exchange: client.exchange.bind(client) });
  const health = await bridge.health(TARGET);
  assert.equal(health.ready, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, TARGET);
});

test('activity handler preserves the caller cancellation signal across the neutral hop', async () => {
  const controller = new AbortController();
  let observedSignal = null;
  const frame = {
    protocol: ENVIRONMENT_BRIDGE_PROTOCOL,
    request: 'a'.repeat(32),
    target: TARGET,
    kind: 'health',
    body: {},
  };
  const handler = createEnvironmentActivityHandler({ activity: {
    async inspect() { return { ready: true, identity: 'foundation-a' }; },
    async list() { return []; },
    async observe() { return observed(); },
    async prepare() { return { generation: 'bootstrap-v1' }; },
    async exchange(candidate, { signal = null } = {}) {
      observedSignal = signal;
      return bridgeResponse(candidate, { version: '1.0.0', features: ['health', 'execute', 'observe', 'cancel', 'put', 'get'] });
    },
  } });
  const response = await handler({
    protocol: ENVIRONMENT_ACTIVITY_AUTHORITY_REQUEST_PROTOCOL,
    requestId: crypto.randomUUID(),
    operation: 'exchange',
    payload: { frame },
  }, { signal: controller.signal });
  assert.equal(response.ok, true);
  assert.equal(observedSignal, controller.signal);
});

test('activity handler fails closed without exposing protected failures', async () => {
  const handler = createEnvironmentActivityHandler({ activity: {
    async inspect() { throw new Error('C:/protected/identity private provider detail'); },
    async list() { return []; },
    async observe() { throw new Error('unavailable'); },
    async prepare() { throw new Error('unavailable'); },
    async exchange() { throw new Error('unavailable'); },
  } });
  const client = new EnvironmentActivityClient({ exchange: handler });
  await assert.rejects(() => client.inspect(), (error) => {
    assert.equal(error.code, 'OPERATION_FAILED');
    assert.equal(error.message.includes('C:/'), false);
    return true;
  });
});

test('activity client rejects response ownership mismatch and unavailable transport', async () => {
  const forged = new EnvironmentActivityClient({ exchange: async (request) => ({
    protocol: 'devbridge/environment-activity-authority-result-v1',
    requestId: `${request.requestId}-wrong`,
    ok: true,
    value: { ready: true, identity: 'x', reason: null },
  }) });
  await assert.rejects(() => forged.inspect(), /ownership proof is invalid/u);

  const missing = new EnvironmentActivityClient({ exchange: async () => { throw new Error('missing'); } });
  await assert.rejects(() => missing.inspect(), /environment activity authority is unavailable/u);
});
