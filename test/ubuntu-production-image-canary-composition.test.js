import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubjectPreparationAdapter } from '../src/app/subject-preparation-adapter.js';
import { createProductionImageCanaryComposition } from '../src/runtime/image-builders/production-image-canary-composition.js';

const IDENTITY = `subject-${'4'.repeat(32)}`;
const IMAGE_IDENTITY = `img-${'5'.repeat(32)}`;

function memoryJournal() {
  const data = new Map();
  return {
    async load(identity) { return data.has(identity) ? structuredClone(data.get(identity)) : undefined; },
    async save(identity, value) { data.set(identity, structuredClone(value)); },
  };
}

function request() {
  return {
    identity: IDENTITY,
    work: { subject: IDENTITY },
    check: { expected: 'opaque' },
    output: { profile: 'linux-pr', generation: 'qualified-1', provenance: { origin: 'production-canary' } },
  };
}

test('production composition maps concrete studs and durable phases only at the topology edge', async () => {
  const calls = [];
  let phase = 'absent';
  const preparation = createSubjectPreparationAdapter({
    async resolve(subject) {
      calls.push(['resolve', subject]);
      return { identity: subject, material: 'physical-opaque' };
    },
    async apply(input) {
      calls.push(['apply', input]);
      phase = 'prepared';
      return { identity: input.identity };
    },
  });
  const construction = {
    async status(identity) { calls.push(['status', identity, phase]); return { identity, phase }; },
    async startInstall(identity) { calls.push(['startInstall', identity]); phase = 'installing'; return { identity }; },
    async bootInstalled(identity) { calls.push(['bootInstalled', identity]); phase = 'qualifying'; return { identity }; },
    async markQualified(identity, evidence) { calls.push(['markQualified', identity, evidence]); phase = 'qualified'; return { identity }; },
    async retain(identity) { calls.push(['retain', identity]); phase = 'retained'; return { identity, location: 'retained-source' }; },
  };
  const qualification = {
    async probe(input) { calls.push(['probe', input]); return { ready: true }; },
    async finalize(identity) { calls.push(['finalize', identity]); return { finalized: true }; },
  };
  const foundation = {
    async publishImage(input) {
      calls.push(['publishImage', input]);
      return { identity: IMAGE_IDENTITY, profile: input.profile, generation: input.generation, digest: '6'.repeat(64), size: 8192 };
    },
    async verifyImage(identity) { calls.push(['verifyImage', identity]); return { identity, usable: true, verified: true }; },
  };
  const canary = createProductionImageCanaryComposition({ journal: memoryJournal(), preparation, construction, qualification, foundation });

  for (let index = 0; index < 11; index += 1) await canary.advance(request());

  assert.deepEqual(calls.map(([name]) => name).filter((name) => name !== 'status'), [
    'resolve', 'apply', 'startInstall', 'bootInstalled', 'probe', 'finalize', 'markQualified',
    'retain', 'retain', 'publishImage', 'verifyImage',
  ]);
  assert.deepEqual(calls.find(([name]) => name === 'resolve'), ['resolve', IDENTITY]);
  assert.deepEqual(calls.find(([name]) => name === 'apply')[1], { identity: IDENTITY, material: 'physical-opaque' });
  const publication = calls.find(([name]) => name === 'publishImage')[1];
  assert.equal(publication.source, 'retained-source');
  assert.deepEqual(publication.provenance, { origin: 'production-canary' });
});

test('production composition rejects topology leakage before physical preparation resolution', async () => {
  let resolved = false;
  const preparation = createSubjectPreparationAdapter({
    async resolve(subject) { resolved = true; return { identity: subject }; },
    async apply(input) { return { identity: input.identity }; },
  });
  const construction = {
    async status(identity) { return { identity, phase: 'absent' }; },
    async startInstall(identity) { return { identity }; },
    async bootInstalled(identity) { return { identity }; },
    async markQualified(identity) { return { identity }; },
    async retain(identity) { return { identity, location: 'retained-source' }; },
  };
  const qualification = { async probe() { return { ready: true }; }, async finalize() { return { finalized: true }; } };
  const foundation = { async publishImage() {}, async verifyImage() {} };
  const canary = createProductionImageCanaryComposition({ journal: memoryJournal(), preparation, construction, qualification, foundation });
  const leaked = { ...request(), work: { subject: IDENTITY, installer: 'forbidden' } };

  await canary.advance(leaked);
  await assert.rejects(() => canary.advance(leaked), /must contain only subject/u);
  assert.equal(resolved, false);
});

test('production composition rejects a concrete construction phase it cannot map into the neutral contract', async () => {
  const preparation = createSubjectPreparationAdapter({
    async resolve(subject) { return { identity: subject }; },
    async apply(input) { return { identity: input.identity }; },
  });
  const construction = {
    async status(identity) { return { identity, phase: 'foreign-phase' }; },
    async startInstall() { return { identity: IDENTITY }; },
    async bootInstalled() { return { identity: IDENTITY }; },
    async markQualified() { return { identity: IDENTITY }; },
    async retain() { return { identity: IDENTITY, location: 'retained-source' }; },
  };
  const qualification = { async probe() { return { ready: true }; }, async finalize() { return { finalized: true }; } };
  const foundation = { async publishImage() {}, async verifyImage() {} };
  const canary = createProductionImageCanaryComposition({ journal: memoryJournal(), preparation, construction, qualification, foundation });
  await canary.advance(request());
  await assert.rejects(() => canary.advance(request()), /phase is unsupported/u);
});
