import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATOR_BROKER_GENERATION_PHASE,
  assertAcceleratorBrokerGenerationStateTransition,
  beginAcceleratorBrokerGenerationRetirement,
  createAcceleratorBrokerGenerationStateRecord,
  normalizeAcceleratorBrokerGenerationStateRecord,
  promoteAcceleratorBrokerGeneration,
} from '../src/runtime/accelerator-broker-generation-state.js';

test('generation state initializes active with exact session identity and generation', () => {
  const record = createAcceleratorBrokerGenerationStateRecord({
    sessionIdentity: 'broker-session-a',
    generation: 'generation-1',
  });
  assert.deepEqual(record, {
    protocol: 'devbridge/accelerator-broker-generation-state-v1',
    revision: 1,
    session: { identity: 'broker-session-a', generation: 'generation-1' },
    phase: ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE,
    retirement: null,
    lastPromotion: null,
  });
});

test('generation state retirement and promotion form one exact monotonic transition pair', () => {
  const active = createAcceleratorBrokerGenerationStateRecord({
    sessionIdentity: 'broker-session-a',
    generation: 'generation-1',
  });
  const retiring = beginAcceleratorBrokerGenerationRetirement(active, {
    operationId: 'retirement-1',
    nextGeneration: 'generation-2',
  });
  assert.equal(retiring.revision, 2);
  assert.equal(retiring.phase, ACCELERATOR_BROKER_GENERATION_PHASE.RETIRING);
  assert.deepEqual(retiring.retirement, { operationId: 'retirement-1', nextGeneration: 'generation-2' });
  assert.deepEqual(assertAcceleratorBrokerGenerationStateTransition(active, retiring), retiring);

  const promoted = promoteAcceleratorBrokerGeneration(retiring, { operationId: 'retirement-1' });
  assert.equal(promoted.revision, 3);
  assert.deepEqual(promoted.session, { identity: 'broker-session-a', generation: 'generation-2' });
  assert.equal(promoted.phase, ACCELERATOR_BROKER_GENERATION_PHASE.ACTIVE);
  assert.equal(promoted.retirement, null);
  assert.deepEqual(promoted.lastPromotion, {
    operationId: 'retirement-1',
    fromGeneration: 'generation-1',
    toGeneration: 'generation-2',
  });
  assert.deepEqual(assertAcceleratorBrokerGenerationStateTransition(retiring, promoted), promoted);
});

test('generation state rejects conflicting promotion identity and illegal transition shapes', () => {
  const active = createAcceleratorBrokerGenerationStateRecord({
    sessionIdentity: 'broker-session-a',
    generation: 'generation-1',
  });
  const retiring = beginAcceleratorBrokerGenerationRetirement(active, {
    operationId: 'retirement-1',
    nextGeneration: 'generation-2',
  });
  assert.throws(() => promoteAcceleratorBrokerGeneration(retiring, { operationId: 'retirement-2' }), /does not match retirement intent/u);
  assert.throws(() => beginAcceleratorBrokerGenerationRetirement(active, {
    operationId: 'retirement-1',
    nextGeneration: 'generation-1',
  }), /must differ/u);
  assert.throws(() => normalizeAcceleratorBrokerGenerationStateRecord({
    ...active,
    retirement: { operationId: 'retirement-1', nextGeneration: 'generation-2' },
  }), /active.*cannot carry retirement/u);
  assert.throws(() => assertAcceleratorBrokerGenerationStateTransition(active, {
    ...retiring,
    revision: 4,
  }), /revision is not contiguous/u);
  assert.throws(() => assertAcceleratorBrokerGenerationStateTransition(active, {
    ...retiring,
    session: { identity: 'broker-session-b', generation: 'generation-1' },
  }), /changed session identity/u);
});

test('last promotion is exact evidence for the current generation only', () => {
  const active = createAcceleratorBrokerGenerationStateRecord({
    sessionIdentity: 'broker-session-a',
    generation: 'generation-2',
  });
  assert.throws(() => normalizeAcceleratorBrokerGenerationStateRecord({
    ...active,
    lastPromotion: {
      operationId: 'retirement-1',
      fromGeneration: 'generation-1',
      toGeneration: 'generation-3',
    },
  }), /does not lead to current generation/u);
});
