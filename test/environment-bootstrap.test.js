import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentBootstrap, ENVIRONMENT_BOOTSTRAP_PROTOCOL, environmentBootstrapGeneration } from '../src/runtime/environment-bootstrap.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const basis = {
  subject: target,
  generation: 3,
  profile: 'linux-dev',
  variant: 'linux',
  source: { identity: 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revision: 'image-7', digest: 'a'.repeat(64) },
};
const plan = {
  revision: 'base-v2',
  requirements: ['source-control', 'runtime-js'],
  protectedNames: ['GITHUB_TOKEN'],
  networkRequired: true,
};

function makeResponse(frame, body) {
  return { protocol: ENVIRONMENT_BOOTSTRAP_PROTOCOL, request: frame.request, target: frame.target, action: frame.action, ok: true, body };
}

function readyBody(generation, extra = {}) {
  return {
    generation,
    basisDigest: extra.basisDigest,
    revision: plan.revision,
    network: { nameResolution: true, secureWeb: true, reason: null },
    capabilities: [
      { id: 'source-control', present: true, usable: true, version: 'git 2.50', reason: null },
      { id: 'runtime-js', present: true, usable: true, version: 'v22.16.0', reason: null },
    ],
    protectedPresent: [],
    reason: null,
    ...extra,
  };
}

function bootstrapWith(exchange, overrides = {}) {
  return new EnvironmentBootstrap({
    basis: async () => basis,
    plan: async () => plan,
    prepare: async () => {},
    exchange,
    cycle: async () => {},
    ...overrides,
  });
}

test('generation is deterministic and binds basis plus local plan', () => {
  const first = environmentBootstrapGeneration({ basis, plan });
  const second = environmentBootstrapGeneration({ basis: structuredClone(basis), plan: { ...plan, requirements: [...plan.requirements].reverse() } });
  assert.equal(first, second);
  assert.notEqual(first, environmentBootstrapGeneration({ basis: { ...basis, generation: 4 }, plan }));
  assert.notEqual(first, environmentBootstrapGeneration({ basis, plan: { ...plan, revision: 'base-v3' } }));
});

test('ensure prepares then applies an exact generation when observation is stale', async () => {
  let prepared = 0;
  let applied = 0;
  let expectedGeneration = null;
  let expectedBasisDigest = null;
  const instance = bootstrapWith(async (_target, frame) => {
    expectedGeneration ??= frame.body.generation;
    expectedBasisDigest ??= frame.body.basisDigest;
    if (frame.action === 'inspect') return makeResponse(frame, { ...readyBody(null, { basisDigest: null }), generation: null, basisDigest: null, revision: null });
    applied += 1;
    return makeResponse(frame, readyBody(expectedGeneration, { basisDigest: expectedBasisDigest }));
  }, { prepare: async (received, receivedBasis) => { prepared += 1; assert.equal(received, target); assert.deepEqual(receivedBasis, basis); } });
  const status = await instance.ensure(target);
  assert.equal(status.ready, true);
  assert.equal(prepared, 1);
  assert.equal(applied, 1);
  assert.equal(status.generation, expectedGeneration);
});

test('presence is distinct from usability and unready capability fails closed', async () => {
  const generation = environmentBootstrapGeneration({ basis, plan });
  const instance = bootstrapWith(async (_target, frame) => makeResponse(frame, {
    ...readyBody(generation, { basisDigest: frame.body.basisDigest }),
    capabilities: [
      { id: 'source-control', present: true, usable: true, version: 'git', reason: null },
      { id: 'runtime-js', present: true, usable: false, version: null, reason: 'probe failed' },
    ],
  }));
  await assert.rejects(() => instance.ensure(target), /required capabilities are unavailable: runtime-js/u);
});

test('protected environment names fail readiness without exposing values', async () => {
  const generation = environmentBootstrapGeneration({ basis, plan });
  const instance = bootstrapWith(async (_target, frame) => makeResponse(frame, {
    ...readyBody(generation, { basisDigest: frame.body.basisDigest }),
    protectedPresent: ['GITHUB_TOKEN'],
  }));
  await assert.rejects(() => instance.ensure(target), /GITHUB_TOKEN/u);
});

test('network health is required when policy requests it', async () => {
  const generation = environmentBootstrapGeneration({ basis, plan });
  const instance = bootstrapWith(async (_target, frame) => makeResponse(frame, {
    ...readyBody(generation, { basisDigest: frame.body.basisDigest }),
    network: { nameResolution: true, secureWeb: false, reason: 'HTTPS unavailable' },
  }));
  await assert.rejects(() => instance.ensure(target), /HTTPS unavailable/u);
});

test('forged response identity fails closed', async () => {
  const instance = bootstrapWith(async (_target, frame) => ({ ...makeResponse(frame, readyBody(frame.body.generation, { basisDigest: frame.body.basisDigest })), target: 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));
  await assert.rejects(() => instance.inspect(target), /identity does not match/u);
});

test('continuity requires the exact basis and generation after a cycle', async () => {
  let currentBasis = structuredClone(basis);
  const exchange = async (_target, frame) => makeResponse(frame, readyBody(frame.body.generation, { basisDigest: frame.body.basisDigest }));
  const instance = bootstrapWith(exchange, {
    basis: async () => currentBasis,
    cycle: async () => { currentBasis = { ...currentBasis, generation: currentBasis.generation + 1 }; },
  });
  await assert.rejects(() => instance.verifyContinuity(target), /continuity changed/u);
});

test('bounded settling can wait for asynchronously applied local prerequisites', async () => {
  let attempts = 0;
  const instance = new EnvironmentBootstrap({
    basis: async () => basis,
    plan: async () => plan,
    prepare: async () => {},
    exchange: async (_target, frame) => {
      attempts += 1;
      if (frame.action === 'inspect' || attempts < 3) {
        return makeResponse(frame, {
          ...readyBody(null, { basisDigest: null }), generation: null, basisDigest: null, revision: null,
          network: { nameResolution: true, secureWeb: false, reason: 'network service is starting' },
        });
      }
      return makeResponse(frame, readyBody(frame.body.generation, { basisDigest: frame.body.basisDigest }));
    },
    settleMs: 1_000,
    pollMs: 100,
  });
  const status = await instance.ensure(target);
  assert.equal(status.ready, true);
  assert.ok(attempts >= 3);
});
