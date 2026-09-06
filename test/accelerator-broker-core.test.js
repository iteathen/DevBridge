import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATOR_BROKER_CANCEL_PROTOCOL,
  ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
  ACCELERATOR_BROKER_OPERATION,
  ACCELERATOR_BROKER_REASON,
  ACCELERATOR_BROKER_STATE,
  createAcceleratorBrokerObservation,
  digestAcceleratorBrokerExecuteRequest,
} from '../src/runtime/accelerator-broker-protocol.js';
import { acceleratorBrokerLedgerKey } from '../src/runtime/accelerator-broker-ledger.js';
import { AcceleratorBrokerCore } from '../src/runtime/accelerator-broker-core.js';

function binding(overrides = {}) {
  return {
    profile: 'profile.cuda',
    environment: { identity: 'environment.cuda', generation: 'environment-generation-1' },
    backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-1' },
    session: { identity: 'broker-session-a', generation: 'broker-session-generation-1' },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: 'request-1',
    executionId: 'execution-1',
    binding: binding(),
    api: 'cuda',
    topology: 'host-retained',
    operation: ACCELERATOR_BROKER_OPERATION.CUDA_CANARY_U32_ADD_V1,
    input: { left: [1, 0xffff_ffff], right: [2, 1] },
    ...overrides,
  };
}

function cancel(value = request(), cancelId = 'cancel-1') {
  return {
    protocol: ACCELERATOR_BROKER_CANCEL_PROTOCOL,
    cancelId,
    requestId: value.requestId,
    executionId: value.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(value),
    binding: value.binding,
  };
}

function observation(value, state, extra = {}) {
  return createAcceleratorBrokerObservation({
    requestId: value.requestId,
    executionId: value.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(value),
    binding: value.binding,
    api: value.api,
    topology: value.topology,
    operation: value.operation,
    state,
    reason: null,
    result: null,
    ...extra,
  });
}

function success(value = request(), values = [3, 0]) {
  return observation(value, ACCELERATOR_BROKER_STATE.SUCCEEDED, { result: { values } });
}

function clone(value) { return value == null ? value : structuredClone(value); }
function keyText(key) { return JSON.stringify(key); }

class MemoryLedger {
  constructor() { this.records = new Map(); this.failCas = 0; }
  async load(key) { return clone(this.records.get(keyText(key)) ?? null); }
  async create(key, record) {
    const selected = keyText(key);
    if (this.records.has(selected)) return false;
    this.records.set(selected, clone(record));
    return true;
  }
  async compareAndSwap(key, expectedRevision, record) {
    if (this.failCas > 0) { this.failCas -= 1; return false; }
    const selected = keyText(key);
    const current = this.records.get(selected);
    if (!current || current.revision !== expectedRevision) return false;
    this.records.set(selected, clone(record));
    return true;
  }
}

class BindingAuthority {
  constructor(expected = binding()) { this.expected = expected; this.calls = 0; }
  async resolveExpectedBinding() { this.calls += 1; return clone(this.expected); }
}

class FakeBackend {
  constructor() {
    this.ensureCalls = 0;
    this.observeCalls = 0;
    this.cancelCalls = 0;
    this.effectStarts = 0;
    this.current = null;
    this.ensureBehavior = null;
    this.observeBehavior = null;
    this.cancelBehavior = null;
  }
  async ensureExecution(input) {
    this.ensureCalls += 1;
    if (this.ensureBehavior) return this.ensureBehavior(input, this);
    if (this.current == null) { this.effectStarts += 1; this.current = success(input.request); }
    return clone(this.current);
  }
  async observeExecution(input) {
    this.observeCalls += 1;
    if (this.observeBehavior) return this.observeBehavior(input, this);
    return clone(this.current);
  }
  async ensureCancellation(input) {
    this.cancelCalls += 1;
    if (this.cancelBehavior) return this.cancelBehavior(input, this);
    this.current = observation(input.request, ACCELERATOR_BROKER_STATE.CANCELLED, { reason: ACCELERATOR_BROKER_REASON.EXECUTION_CANCELLED });
    return clone(this.current);
  }
}

function broker({ authority = new BindingAuthority(), ledger = new MemoryLedger(), backend = new FakeBackend() } = {}) {
  return { core: new AcceleratorBrokerCore({ authority, ledger, backend }), authority, ledger, backend };
}

test('new exact request persists intent before backend ensure and returns verified success', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input) => {
    const stored = await state.ledger.load(acceleratorBrokerLedgerKey(input.request));
    assert.equal(stored.observation.state, 'accepted');
    state.backend.effectStarts += 1;
    state.backend.current = success(input.request);
    return state.backend.current;
  };
  const result = await state.core.execute(request());
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.result.values, [3, 0]);
  assert.equal(state.backend.ensureCalls, 1);
  assert.equal(state.backend.effectStarts, 1);
});

test('stale or unavailable host binding rejects before backend effect', async () => {
  const staleAuthority = new BindingAuthority(binding({ backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-2' } }));
  const stale = broker({ authority: staleAuthority });
  const staleResult = await stale.core.execute(request());
  assert.equal(staleResult.state, 'rejected');
  assert.equal(staleResult.reason, 'binding-stale');
  assert.equal(stale.backend.ensureCalls, 0);

  const unavailableAuthority = new BindingAuthority(null);
  const unavailable = broker({ authority: unavailableAuthority });
  const unavailableResult = await unavailable.core.execute(request());
  assert.equal(unavailableResult.state, 'rejected');
  assert.equal(unavailableResult.reason, 'backend-unavailable');
  assert.equal(unavailable.backend.ensureCalls, 0);
});

test('exact replay returns terminal evidence without starting another effect', async () => {
  const state = broker();
  const first = await state.core.execute(request());
  const second = await state.core.execute(request());
  assert.deepEqual(second, first);
  assert.equal(state.backend.ensureCalls, 1);
  assert.equal(state.backend.effectStarts, 1);
});

test('conflicting request reuse is rejected without touching the recorded effect', async () => {
  const state = broker();
  await state.core.execute(request());
  const conflict = request({ executionId: 'execution-2', input: { left: [9], right: [1] } });
  const result = await state.core.execute(conflict);
  assert.equal(result.state, 'rejected');
  assert.equal(result.reason, 'request-conflict');
  assert.equal(state.backend.ensureCalls, 1);
});

test('ambiguous ensure is reconciled by observation and never blindly starts a second effect', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input, backend) => {
    backend.effectStarts += 1;
    backend.current = success(input.request);
    throw new Error('response lost after effect');
  };
  const result = await state.core.execute(request());
  assert.equal(result.state, 'succeeded');
  assert.equal(state.backend.effectStarts, 1);
  assert.equal(state.backend.ensureCalls, 1);
  assert.equal(state.backend.observeCalls, 1);
  const replay = await state.core.execute(request());
  assert.equal(replay.state, 'succeeded');
  assert.equal(state.backend.effectStarts, 1);
});

test('unknown effect may safely resume only through idempotent ensure semantics', async () => {
  const state = broker();
  let first = true;
  state.backend.ensureBehavior = async (input, backend) => {
    if (first) { first = false; throw new Error('failed before effect was provably started'); }
    if (backend.current == null) { backend.effectStarts += 1; backend.current = success(input.request); }
    return backend.current;
  };
  const unknown = await state.core.execute(request());
  assert.equal(unknown.state, 'unknown');
  assert.equal(state.backend.effectStarts, 0);
  const resolved = await state.core.execute(request());
  assert.equal(resolved.state, 'succeeded');
  assert.equal(state.backend.ensureCalls, 2);
  assert.equal(state.backend.effectStarts, 1);
});

test('read-only observe never calls ensure and preserves unknown when backend cannot prove state', async () => {
  const state = broker();
  state.backend.ensureBehavior = async () => { throw new Error('unknown'); };
  const first = await state.core.execute(request());
  assert.equal(first.state, 'unknown');
  const ensureCalls = state.backend.ensureCalls;
  const result = await state.core.observe(request());
  assert.equal(result.state, 'unknown');
  assert.equal(state.backend.ensureCalls, ensureCalls);
  assert.ok(state.backend.observeCalls >= 2);
});

test('read-only observe fences stale binding before touching the backend observer', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input, backend) => {
    backend.current = observation(input.request, ACCELERATOR_BROKER_STATE.RUNNING);
    return backend.current;
  };
  const running = await state.core.execute(request());
  assert.equal(running.state, 'running');
  state.authority.expected = binding({ backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-2' } });
  const priorObserveCalls = state.backend.observeCalls;
  const result = await state.core.observe(request());
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'state-unknown');
  assert.equal(state.backend.observeCalls, priorObserveCalls);
});

test('broker independently rejects a backend success with the wrong canary result', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input) => success(input.request, [4, 0]);
  const result = await state.core.execute(request());
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'execution-failed');
  assert.equal(result.result, null);
});

test('invalid backend state transition degrades to unknown instead of preserving misleading state', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input) => observation(input.request, ACCELERATOR_BROKER_STATE.REJECTED, {
    reason: ACCELERATOR_BROKER_REASON.BINDING_STALE,
  });
  const result = await state.core.execute(request());
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'state-unknown');
  const stored = await state.ledger.load(acceleratorBrokerLedgerKey(request()));
  assert.equal(stored.observation.state, 'unknown');
});

test('binding generation drift fences nonterminal replay without invoking stale backend', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input) => observation(input.request, ACCELERATOR_BROKER_STATE.RUNNING);
  const running = await state.core.execute(request());
  assert.equal(running.state, 'running');
  const priorEnsure = state.backend.ensureCalls;
  state.authority.expected = binding({ backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-2' } });
  const fenced = await state.core.execute(request());
  assert.equal(fenced.state, 'unknown');
  assert.equal(fenced.reason, 'state-unknown');
  assert.equal(state.backend.ensureCalls, priorEnsure);
});

test('cancellation intent is persisted before the idempotent backend cancellation effect', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input, backend) => {
    backend.current = observation(input.request, ACCELERATOR_BROKER_STATE.RUNNING);
    return backend.current;
  };
  await state.core.execute(request());
  state.backend.cancelBehavior = async (input, backend) => {
    const stored = await state.ledger.load(acceleratorBrokerLedgerKey(input.request));
    assert.equal(stored.cancelIntent.request.cancelId, 'cancel-1');
    backend.current = observation(input.request, ACCELERATOR_BROKER_STATE.CANCELLED, { reason: ACCELERATOR_BROKER_REASON.EXECUTION_CANCELLED });
    return backend.current;
  };
  const result = await state.core.cancel(cancel());
  assert.equal(result.state, 'cancelled');
  assert.equal(state.backend.cancelCalls, 1);
});

test('ambiguous cancellation reconciles by observation and exact replay does not repeat cancellation', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input, backend) => {
    backend.current = observation(input.request, ACCELERATOR_BROKER_STATE.RUNNING);
    return backend.current;
  };
  await state.core.execute(request());
  state.backend.cancelBehavior = async (input, backend) => {
    backend.current = observation(input.request, ACCELERATOR_BROKER_STATE.CANCELLED, { reason: ACCELERATOR_BROKER_REASON.EXECUTION_CANCELLED });
    throw new Error('cancel response lost');
  };
  const first = await state.core.cancel(cancel());
  assert.equal(first.state, 'cancelled');
  assert.equal(state.backend.cancelCalls, 1);
  const second = await state.core.cancel(cancel());
  assert.equal(second.state, 'cancelled');
  assert.equal(state.backend.cancelCalls, 1);
});

test('conflicting second cancellation cannot widen into another backend cancellation effect', async () => {
  const state = broker();
  state.backend.ensureBehavior = async (input, backend) => {
    backend.current = observation(input.request, ACCELERATOR_BROKER_STATE.RUNNING);
    return backend.current;
  };
  state.backend.cancelBehavior = async (input, backend) => {
    backend.current = observation(input.request, ACCELERATOR_BROKER_STATE.RUNNING);
    return backend.current;
  };
  await state.core.execute(request());
  const first = await state.core.cancel(cancel());
  assert.equal(first.state, 'running');
  await assert.rejects(() => state.core.cancel(cancel(request(), 'cancel-2')), /conflicts with active cancellation intent/u);
  assert.equal(state.backend.cancelCalls, 1);
});

test('CAS contention reconciles against the durable record instead of overwriting it', async () => {
  const state = broker();
  state.ledger.failCas = 1;
  const result = await state.core.execute(request());
  assert.equal(result.state, 'succeeded');
  const stored = await state.ledger.load(acceleratorBrokerLedgerKey(request()));
  assert.equal(stored.observation.state, 'succeeded');
  assert.ok(stored.revision >= 2);
});
