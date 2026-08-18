import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextBudgetManager, contextCheckpointPolicy } from '../src/context/context-budget.js';
import { ProtocolError } from '../src/errors.js';

test('context budget crosses soft, preferred, and hard rollover thresholds deterministically', () => {
  const budget = new ContextBudgetManager({ unit: 'proxy', capacityUnits: 1000, softRatio: 0.55, preferredRatio: 0.65, hardRatio: 0.75 });
  assert.equal(budget.observe({ proxyUnits: 549, source: 'initial' }).level, 'normal');
  let state = budget.observe({ proxyUnits: 1, source: 'tool' });
  assert.equal(state.level, 'checkpoint');
  assert.equal(state.checkpointRequested, true);
  state = budget.observe({ proxyUnits: 100, source: 'tool' });
  assert.equal(state.level, 'rollover-preferred');
  assert.equal(state.rolloverPreferred, true);
  state = budget.observe({ proxyUnits: 100, source: 'tool' });
  assert.equal(state.level, 'rollover-required');
  assert.equal(state.rolloverRequired, true);
});

test('context budget supports exact-token and byte-proxy modes without mixing units', () => {
  const tokenBudget = new ContextBudgetManager({ unit: 'tokens', capacityUnits: 100 });
  assert.equal(tokenBudget.observe({ tokens: 60, bytes: 9999, source: 'model' }).usedUnits, 60);
  assert.throws(() => tokenBudget.observe({ bytes: 10, source: 'wrong-unit' }), ProtocolError);

  const byteBudget = new ContextBudgetManager({ unit: 'bytes', capacityUnits: 10_000 });
  assert.equal(byteBudget.observe({ bytes: 5000, source: 'tool-output' }).usedUnits, 5000);
  assert.throws(() => byteBudget.observe({ tokens: 10, source: 'wrong-unit' }), ProtocolError);
});

test('context budget ratios are explicit configuration and must remain ordered', () => {
  assert.throws(() => new ContextBudgetManager({ softRatio: 0.7, preferredRatio: 0.6, hardRatio: 0.8 }), /softRatio < preferredRatio < hardRatio/u);
  assert.throws(() => new ContextBudgetManager({ unit: 'guesses' }), /tokens, bytes, or proxy/u);
  assert.throws(() => new ContextBudgetManager({ capacityUnits: 0 }), /positive safe integer/u);
});

test('durable action boundaries checkpoint even below the soft context threshold', () => {
  const budget = new ContextBudgetManager({ unit: 'bytes', capacityUnits: 100_000 });
  const snapshot = budget.observe({ bytes: 1000, source: 'small-turn' });
  assert.equal(snapshot.level, 'normal');
  assert.deepEqual(contextCheckpointPolicy('candidate-sealed', snapshot), {
    event: 'candidate-sealed',
    durableBoundary: true,
    checkpoint: true,
    rollover: 'none',
    reason: 'durable-boundary',
  });
  assert.equal(contextCheckpointPolicy('ordinary-turn', snapshot).checkpoint, false);
});

test('budget pressure checkpoints and requests rollover without inventing a stop gate', () => {
  const budget = new ContextBudgetManager({ unit: 'proxy', capacityUnits: 100 });
  const preferred = budget.observe({ proxyUnits: 66, source: 'actions' });
  const policy = contextCheckpointPolicy('ordinary-turn', preferred);
  assert.equal(policy.checkpoint, true);
  assert.equal(policy.rollover, 'preferred');
  const hard = budget.observe({ proxyUnits: 10, source: 'large-evidence' });
  assert.equal(contextCheckpointPolicy('ordinary-turn', hard).rollover, 'required');
});
