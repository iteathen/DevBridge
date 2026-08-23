import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalImageCanary } from '../src/runtime/image-builders/canonical-image-canary.js';

const IDENTITY = `subject-${'1'.repeat(32)}`;
const IMAGE_IDENTITY = `img-${'2'.repeat(32)}`;
const IMAGE_DIGEST = '3'.repeat(64);

function request(overrides = {}) {
  return {
    identity: IDENTITY,
    work: { identity: IDENTITY, opaque: { generation: 'work-1' } },
    check: { generation: 'check-1', commands: ['cc'] },
    output: {
      profile: 'linux-build',
      generation: 'image-generation-1',
      provenance: { origin: 'local-construction', authority: IDENTITY },
    },
    ...overrides,
  };
}

function memoryJournal() {
  const values = new Map();
  let failedPhase = null;
  return {
    async load(identity) { return values.has(identity) ? structuredClone(values.get(identity)) : undefined; },
    async save(identity, value) {
      if (failedPhase === value.phase) {
        failedPhase = null;
        throw new Error(`simulated outer ${value.phase} checkpoint loss`);
      }
      values.set(identity, structuredClone(value));
    },
    failOn(phase) { failedPhase = phase; },
  };
}

function harness({ journal = memoryJournal(), probe = null, finalize = null, verify = null } = {}) {
  const calls = [];
  let constructionState = 'absent';
  const construction = {
    async prepare(input) {
      calls.push(['prepare', structuredClone(input)]);
      constructionState = 'prepared';
      return { identity: IDENTITY };
    },
    async observe(identity) {
      calls.push(['observe', identity, constructionState]);
      return { identity, state: constructionState };
    },
    async start(identity) {
      calls.push(['start', identity]);
      constructionState = 'running';
      return { identity };
    },
    async activate(identity) {
      calls.push(['activate', identity]);
      constructionState = 'active';
      return { identity };
    },
    async accept(identity, evidence) {
      calls.push(['accept', identity, structuredClone(evidence)]);
      constructionState = 'accepted';
      return { identity };
    },
    async retain(identity) {
      calls.push(['retain', identity]);
      constructionState = 'retained';
      return { identity, location: '/owned/opaque/canonical.img' };
    },
  };
  const qualification = {
    async probe(input) {
      calls.push(['probe', structuredClone(input)]);
      if (probe) return probe(input);
      return { protocol: 'probe-v1', ready: true, generation: input.expected.generation };
    },
    async finalize(identity) {
      calls.push(['finalize', identity]);
      if (finalize) return finalize(identity);
      return { protocol: 'finalization-v1', finalized: true };
    },
  };
  const images = {
    async publish(input) {
      calls.push(['publish', structuredClone(input)]);
      return {
        identity: IMAGE_IDENTITY,
        profile: input.profile,
        generation: input.generation,
        digest: IMAGE_DIGEST,
        size: 4096,
      };
    },
    async verify(identity) {
      calls.push(['verify', identity]);
      if (verify) return verify(identity);
      return { identity, usable: true, verified: true };
    },
  };
  return { journal, calls, construction, qualification, images };
}

function canary(parts) {
  return createCanonicalImageCanary({
    journal: parts.journal,
    construction: parts.construction,
    qualification: parts.qualification,
    images: parts.images,
  });
}

function effectNames(parts) {
  return parts.calls.map(([name]) => name).filter((name) => name !== 'observe');
}

test('canary advances one durable phase at a time and survives a fresh coordinator between every phase', async () => {
  const parts = harness();
  const phases = [
    'planned',
    'prepared',
    'running',
    'active',
    'probed',
    'finalization-planned',
    'finalized',
    'accepted',
    'retained',
    'published',
    'completed',
  ];

  for (const phase of phases) {
    const status = await canary(parts).advance(request());
    assert.equal(status.phase, phase);
    assert.equal(status.blocked, false);
  }

  const status = await canary(parts).inspect(request());
  assert.equal(status.complete, true);
  assert.equal(status.image.identity, IMAGE_IDENTITY);
  assert.equal(JSON.stringify(status).includes('/owned/'), false);
  assert.deepEqual(effectNames(parts), [
    'prepare',
    'start',
    'activate',
    'probe',
    'finalize',
    'accept',
    'retain',
    'retain',
    'publish',
    'verify',
  ]);

  const accepted = parts.calls.find(([name]) => name === 'accept');
  assert.deepEqual(accepted[2], {
    probe: { generation: 'check-1', protocol: 'probe-v1', ready: true },
    finalization: { finalized: true, protocol: 'finalization-v1' },
  });
});

test('outer restart reconciles completed inner construction effects instead of replaying them', async () => {
  const cases = [
    { phase: 'prepared', setupAdvances: 1, effect: 'prepare' },
    { phase: 'running', setupAdvances: 2, effect: 'start' },
    { phase: 'active', setupAdvances: 3, effect: 'activate' },
    { phase: 'accepted', setupAdvances: 7, effect: 'accept' },
    { phase: 'retained', setupAdvances: 8, effect: 'retain' },
  ];

  for (const item of cases) {
    const journal = memoryJournal();
    const parts = harness({ journal });
    for (let index = 0; index < item.setupAdvances; index += 1) await canary(parts).advance(request());
    journal.failOn(item.phase);
    await assert.rejects(() => canary(parts).advance(request()), new RegExp(`simulated outer ${item.phase} checkpoint loss`, 'u'));
    const countAfterEffect = effectNames(parts).filter((name) => name === item.effect).length;
    assert.equal(countAfterEffect, 1, `${item.effect} should have completed exactly once before outer checkpoint loss`);

    const resumed = await canary(parts).advance(request());
    assert.equal(resumed.phase, item.phase);
    assert.equal(effectNames(parts).filter((name) => name === item.effect).length, countAfterEffect, `${item.effect} must not replay after restart`);
  }
});

test('destructive finalization intent is durable before the effect starts', async () => {
  const journal = memoryJournal();
  let observedPhase = null;
  const parts = harness({
    journal,
    finalize: async () => {
      observedPhase = (await journal.load(IDENTITY)).phase;
      return { finalized: true, protocol: 'finalization-v1' };
    },
  });

  for (let index = 0; index < 6; index += 1) await canary(parts).advance(request());
  const result = await canary(parts).advance(request());
  assert.equal(observedPhase, 'finalization-attempted');
  assert.equal(result.phase, 'finalized');
});

test('interrupted destructive finalization is observed and blocked rather than replayed or admitted', async () => {
  const journal = memoryJournal();
  let finalizeCalls = 0;
  const parts = harness({
    journal,
    finalize: async () => {
      finalizeCalls += 1;
      throw new Error('simulated host loss after destructive effect became ambiguous');
    },
  });

  for (let index = 0; index < 6; index += 1) await canary(parts).advance(request());
  await assert.rejects(() => canary(parts).advance(request()), /simulated host loss/u);
  assert.equal((await journal.load(IDENTITY)).phase, 'finalization-attempted');

  const observationsBeforeResume = parts.calls.filter(([name]) => name === 'observe').length;
  const resumed = await canary(parts).advance(request());
  assert.equal(resumed.phase, 'finalization-attempted');
  assert.equal(resumed.blocked, true);
  assert.match(resumed.reason, /exact reconciliation/u);
  assert.equal(finalizeCalls, 1);
  assert.equal(parts.calls.filter(([name]) => name === 'observe').length, observationsBeforeResume + 1);
  assert.equal(parts.calls.some(([name]) => name === 'accept'), false);
  assert.equal(parts.calls.some(([name]) => name === 'publish'), false);
});

test('failed functional probe cannot cross the finalization or admission boundary', async () => {
  const parts = harness({ probe: async () => { throw new Error('functional probe failed'); } });
  for (let index = 0; index < 4; index += 1) await canary(parts).advance(request());
  await assert.rejects(() => canary(parts).advance(request()), /functional probe failed/u);

  const status = await canary(parts).inspect(request());
  assert.equal(status.phase, 'active');
  assert.equal(parts.calls.some(([name]) => name === 'finalize'), false);
  assert.equal(parts.calls.some(([name]) => name === 'publish'), false);
});

test('request drift is rejected before another effect can start', async () => {
  const parts = harness();
  await canary(parts).advance(request());
  assert.equal(parts.calls.length, 0);

  const changed = request({
    output: {
      profile: 'linux-build',
      generation: 'image-generation-2',
      provenance: { origin: 'local-construction', authority: IDENTITY },
    },
  });
  await assert.rejects(() => canary(parts).advance(changed), /journal authority does not match/u);
  assert.equal(parts.calls.length, 0);
});

test('published bytes must reverify through the admission stud before completion', async () => {
  const parts = harness({ verify: async (identity) => ({ identity, usable: false, verified: true, reason: 'media changed' }) });
  for (let index = 0; index < 10; index += 1) await canary(parts).advance(request());
  await assert.rejects(() => canary(parts).advance(request()), /did not verify/u);
  const status = await canary(parts).inspect(request());
  assert.equal(status.phase, 'published');
  assert.equal(status.complete, false);
});

test('canonical request digest is stable across opaque object and provenance key ordering', async () => {
  const parts = harness();
  await canary(parts).advance(request({
    work: { z: 1, identity: IDENTITY, a: { second: 2, first: 1 } },
    output: {
      profile: 'linux-build',
      generation: 'image-generation-1',
      provenance: { authority: IDENTITY, origin: 'local-construction' },
    },
  }));

  const reordered = request({
    work: { a: { first: 1, second: 2 }, identity: IDENTITY, z: 1 },
    output: {
      profile: 'linux-build',
      generation: 'image-generation-1',
      provenance: { origin: 'local-construction', authority: IDENTITY },
    },
  });
  const status = await canary(parts).inspect(reordered);
  assert.equal(status.phase, 'planned');
});
