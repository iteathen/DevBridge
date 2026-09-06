import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATOR_BROKER_CANCEL_PROTOCOL,
  ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
  ACCELERATOR_BROKER_OPERATION,
  ACCELERATOR_BROKER_REASON,
  ACCELERATOR_BROKER_STATE,
  digestAcceleratorBrokerExecuteRequest,
} from '../src/runtime/accelerator-broker-protocol.js';
import {
  ACCELERATOR_BROKER_GENERATION_PHASE,
  normalizeAcceleratorBrokerGenerationStateRecord,
} from '../src/runtime/accelerator-broker-generation-state.js';
import { createAcceleratorBrokerGenerationAdmission } from '../src/runtime/accelerator-broker-generation-admission.js';
import {
  ACCELERATOR_BROKER_GENERATION_RETIRE_PROTOCOL,
  AcceleratorBrokerGenerationController,
} from '../src/runtime/accelerator-broker-generation-controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function executeRequest({ requestId = 'request-1', generation = 'generation-1', sessionIdentity = 'broker-session-a' } = {}) {
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId,
    executionId: `execution-${requestId}`,
    binding: {
      profile: 'profile.cuda',
      environment: { identity: 'environment.cuda', generation: 'environment-generation-1' },
      backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-1' },
      session: { identity: sessionIdentity, generation },
    },
    api: 'cuda',
    topology: 'host-retained',
    operation: ACCELERATOR_BROKER_OPERATION.CUDA_CANARY_U32_ADD_V1,
    input: { left: [1], right: [2] },
  };
}

function cancelRequest(request, { cancelId = 'cancel-1' } = {}) {
  return {
    protocol: ACCELERATOR_BROKER_CANCEL_PROTOCOL,
    cancelId,
    requestId: request.requestId,
    executionId: request.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(request),
    binding: request.binding,
  };
}

function retireRequest({ operationId = 'retirement-1', retiringGeneration = 'generation-1', nextGeneration = 'generation-2' } = {}) {
  return {
    protocol: ACCELERATOR_BROKER_GENERATION_RETIRE_PROTOCOL,
    operationId,
    sessionIdentity: 'broker-session-a',
    retiringGeneration,
    nextGeneration,
  };
}

function generationObservation({ generation = 'generation-1', nonterminalCount = 0, terminalCount = 0 } = {}) {
  const recordCount = nonterminalCount + terminalCount;
  return {
    protocol: 'devbridge/accelerator-broker-generation-observation-v1',
    session: { identity: 'broker-session-a', generation },
    recordCount,
    terminalCount,
    nonterminalCount,
    quiescent: nonterminalCount === 0,
  };
}

class MemoryGenerationStateStore {
  current = null;
  failPromotionOnce = false;

  async load() {
    return this.current;
  }

  async create(_key, rawRecord) {
    if (this.current) return false;
    this.current = normalizeAcceleratorBrokerGenerationStateRecord(rawRecord);
    return true;
  }

  async compareAndSwap(_key, expectedRevision, rawRecord) {
    if (!this.current || this.current.revision !== expectedRevision) return false;
    const record = normalizeAcceleratorBrokerGenerationStateRecord(rawRecord);
    if (this.failPromotionOnce && this.current.phase === ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING
      && record.phase === ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE) {
      this.failPromotionOnce = false;
      throw new Error('injected promotion persistence interruption');
    }
    this.current = record;
    return true;
  }
}

function fakeCore({ executeImpl = null } = {}) {
  const calls = { execute: [], observe: [], cancel: [] };
  return {
    calls,
    async execute(request) {
      calls.execute.push(request);
      return executeImpl ? executeImpl(request) : { delegated: 'execute', requestId: request.requestId };
    },
    async observe(request) {
      calls.observe.push(request);
      return { delegated: 'observe', requestId: request.requestId };
    },
    async cancel(cancel) {
      calls.cancel.push(cancel);
      return { delegated: 'cancel', requestId: cancel.requestId };
    },
  };
}

function fakeCatalog(initial) {
  let behavior = initial;
  const calls = [];
  return {
    calls,
    set(next) { behavior = next; },
    async observeGeneration(selector) {
      calls.push(selector);
      return typeof behavior === 'function' ? behavior(selector) : behavior;
    },
  };
}

function controller({ state = new MemoryGenerationStateStore(), core = fakeCore(), catalog = fakeCatalog(generationObservation()), admission = createAcceleratorBrokerGenerationAdmission() } = {}) {
  return {
    state,
    core,
    catalog,
    admission,
    value: new AcceleratorBrokerGenerationController({
      sessionIdentity: 'broker-session-a',
      initialGeneration: 'generation-1',
      core,
      state,
      catalog,
      admission,
    }),
  };
}

test('active generation execute delegates while foreign or stale generation execute is fenced before core', async () => {
  const fixture = controller();
  const allowed = await fixture.value.execute(executeRequest());
  assert.deepEqual(allowed, { delegated: 'execute', requestId: 'request-1' });
  assert.equal(fixture.core.calls.execute.length, 1);

  const stale = await fixture.value.execute(executeRequest({ requestId: 'request-stale', generation: 'generation-0' }));
  assert.equal(stale.state, ACCELERATOR_BROKER_STATE.REJECTED);
  assert.equal(stale.reason, ACCELERATOR_BROKER_REASON.BINDING_STALE);
  const foreign = await fixture.value.execute(executeRequest({ requestId: 'request-foreign', sessionIdentity: 'broker-session-b' }));
  assert.equal(foreign.state, ACCELERATOR_BROKER_STATE.REJECTED);
  assert.equal(fixture.core.calls.execute.length, 1);
});

test('nonterminal catalog evidence durably blocks promotion and fences new execute while observe/cancel remain available', async () => {
  const catalog = fakeCatalog(generationObservation({ nonterminalCount: 1 }));
  const fixture = controller({ catalog });
  const retirement = await fixture.value.retire(retireRequest());
  assert.equal(retirement.status, 'blocked');
  assert.equal(retirement.quiescence.nonterminalCount, 1);
  assert.equal(fixture.state.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);
  assert.equal(fixture.state.current.session.generation, 'generation-1');

  const request = executeRequest({ requestId: 'request-after-retirement' });
  const fenced = await fixture.value.execute(request);
  assert.equal(fenced.state, ACCELERATOR_BROKER_STATE.REJECTED);
  assert.equal(fixture.core.calls.execute.length, 0);

  assert.deepEqual(await fixture.value.observe(request), { delegated: 'observe', requestId: request.requestId });
  assert.deepEqual(await fixture.value.cancel(cancelRequest(request)), { delegated: 'cancel', requestId: request.requestId });
  assert.equal(fixture.core.calls.observe.length, 1);
  assert.equal(fixture.core.calls.cancel.length, 1);
});

test('pre-retirement execute admission drains before retiring intent is persisted', async () => {
  const entered = deferred();
  const finishExecute = deferred();
  const core = fakeCore({ executeImpl: async (request) => {
    entered.resolve();
    await finishExecute.promise;
    return { delegated: 'execute', requestId: request.requestId };
  } });
  const catalog = fakeCatalog(generationObservation());
  const fixture = controller({ core, catalog });

  const executing = fixture.value.execute(executeRequest());
  await entered.promise;
  const retiring = fixture.value.retire(retireRequest());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.state.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE);
  assert.equal(catalog.calls.length, 0);

  finishExecute.resolve();
  assert.deepEqual(await executing, { delegated: 'execute', requestId: 'request-1' });
  const result = await retiring;
  assert.equal(result.status, 'promoted');
  assert.equal(fixture.state.current.session.generation, 'generation-2');
});

test('queued retirement cannot be overtaken by later execute between quiescence proof and promotion', async () => {
  const firstEntered = deferred();
  const finishFirst = deferred();
  const core = fakeCore({ executeImpl: async (request) => {
    if (request.requestId === 'request-first') {
      firstEntered.resolve();
      await finishFirst.promise;
    }
    return { delegated: 'execute', requestId: request.requestId };
  } });
  const catalogEntered = deferred();
  const releaseCatalog = deferred();
  const catalog = fakeCatalog(async () => {
    catalogEntered.resolve();
    await releaseCatalog.promise;
    return generationObservation();
  });
  const fixture = controller({ core, catalog });

  const first = fixture.value.execute(executeRequest({ requestId: 'request-first' }));
  await firstEntered.promise;
  const retiring = fixture.value.retire(retireRequest());
  const later = fixture.value.execute(executeRequest({ requestId: 'request-later' }));
  finishFirst.resolve();
  await first;
  await catalogEntered.promise;
  assert.equal(fixture.state.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);
  assert.equal(core.calls.execute.length, 1);

  releaseCatalog.resolve();
  const retirement = await retiring;
  assert.equal(retirement.status, 'promoted');
  const laterResult = await later;
  assert.equal(laterResult.state, ACCELERATOR_BROKER_STATE.REJECTED);
  assert.equal(laterResult.reason, ACCELERATOR_BROKER_REASON.BINDING_STALE);
  assert.equal(core.calls.execute.length, 1);
  assert.equal(fixture.state.current.session.generation, 'generation-2');
});

test('restart after durable retirement intent cannot reopen old-generation execute and same operation may resume', async () => {
  const state = new MemoryGenerationStateStore();
  const firstCatalog = fakeCatalog(generationObservation({ nonterminalCount: 1 }));
  const firstCore = fakeCore();
  const first = controller({ state, catalog: firstCatalog, core: firstCore });
  assert.equal((await first.value.retire(retireRequest())).status, 'blocked');
  assert.equal(state.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);

  const secondCatalog = fakeCatalog(generationObservation());
  const secondCore = fakeCore();
  const restarted = controller({ state, catalog: secondCatalog, core: secondCore });
  const fenced = await restarted.value.execute(executeRequest({ requestId: 'request-after-restart' }));
  assert.equal(fenced.state, ACCELERATOR_BROKER_STATE.REJECTED);
  assert.equal(secondCore.calls.execute.length, 0);
  const promoted = await restarted.value.retire(retireRequest());
  assert.equal(promoted.status, 'promoted');
  assert.equal(state.current.session.generation, 'generation-2');
});

test('interruption after quiescence but before promotion leaves durable retiring fence for restart', async () => {
  const state = new MemoryGenerationStateStore();
  state.failPromotionOnce = true;
  const first = controller({ state, catalog: fakeCatalog(generationObservation()) });
  await assert.rejects(() => first.value.retire(retireRequest()), /injected promotion persistence interruption/u);
  assert.equal(state.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);
  assert.equal(state.current.session.generation, 'generation-1');

  const restartedCore = fakeCore();
  const restarted = controller({ state, core: restartedCore, catalog: fakeCatalog(generationObservation()) });
  const fenced = await restarted.value.execute(executeRequest({ requestId: 'request-after-crash' }));
  assert.equal(fenced.state, ACCELERATOR_BROKER_STATE.REJECTED);
  assert.equal(restartedCore.calls.execute.length, 0);
  assert.equal((await restarted.value.retire(retireRequest())).status, 'promoted');
});

test('malformed or another-generation quiescence evidence cannot promote and leaves retiring state', async () => {
  const state = new MemoryGenerationStateStore();
  const wrong = controller({ state, catalog: fakeCatalog(generationObservation({ generation: 'generation-other' })) });
  await assert.rejects(() => wrong.value.retire(retireRequest()), /another generation|belongs to another generation/u);
  assert.equal(state.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);

  const state2 = new MemoryGenerationStateStore();
  const malformed = controller({ state: state2, catalog: fakeCatalog({ protocol: 'wrong' }) });
  await assert.rejects(() => malformed.value.retire(retireRequest()), /protocol is unsupported/u);
  assert.equal(state2.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);
});

test('promotion retry is idempotent and next-generation execute becomes admissible', async () => {
  const catalog = fakeCatalog(generationObservation());
  const fixture = controller({ catalog });
  const first = await fixture.value.retire(retireRequest());
  assert.equal(first.status, 'promoted');
  assert.equal(first.replayed, false);
  assert.equal(catalog.calls.length, 1);

  const replay = await fixture.value.retire(retireRequest());
  assert.equal(replay.status, 'promoted');
  assert.equal(replay.replayed, true);
  assert.equal(replay.quiescence, null);
  assert.equal(catalog.calls.length, 1);

  const next = await fixture.value.execute(executeRequest({ requestId: 'request-next', generation: 'generation-2' }));
  assert.deepEqual(next, { delegated: 'execute', requestId: 'request-next' });
  assert.equal(fixture.core.calls.execute.length, 1);
});

test('conflicting retirement operation fails closed while original retiring intent remains durable', async () => {
  const fixture = controller({ catalog: fakeCatalog(generationObservation({ nonterminalCount: 1 })) });
  assert.equal((await fixture.value.retire(retireRequest())).status, 'blocked');
  await assert.rejects(() => fixture.value.retire(retireRequest({ operationId: 'retirement-conflict', nextGeneration: 'generation-3' })), /conflicts with current generation state/u);
  assert.equal(fixture.state.current.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);
  assert.deepEqual(fixture.state.current.retirement, {
    operationId: 'retirement-1',
    nextGeneration: 'generation-2',
  });
});
