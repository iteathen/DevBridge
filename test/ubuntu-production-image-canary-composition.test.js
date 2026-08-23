import test from 'node:test';
import assert from 'node:assert/strict';
import { createUbuntuProductionImageCanaryComposition } from '../src/runtime/image-builders/ubuntu-production-image-canary-composition.js';

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
    work: { identity: IDENTITY, material: 'opaque' },
    check: { expected: 'opaque' },
    output: { profile: 'linux-pr', generation: 'qualified-1', provenance: { origin: 'production-canary' } },
  };
}

test('production composition maps concrete studs and durable phases only at the topology edge', async () => {
  const calls = [];
  let phase = 'absent';
  const construction = {
    async prepare(input) { calls.push(['prepare', input]); phase = 'prepared'; return { identity: IDENTITY }; },
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
  const canary = createUbuntuProductionImageCanaryComposition({ journal: memoryJournal(), construction, qualification, foundation });

  for (let index = 0; index < 11; index += 1) await canary.advance(request());

  assert.deepEqual(calls.map(([name]) => name).filter((name) => name !== 'status'), [
    'prepare', 'startInstall', 'bootInstalled', 'probe', 'finalize', 'markQualified',
    'retain', 'retain', 'publishImage', 'verifyImage',
  ]);
  const publication = calls.find(([name]) => name === 'publishImage')[1];
  assert.equal(publication.source, 'retained-source');
  assert.deepEqual(publication.provenance, { origin: 'production-canary' });
});

test('production composition rejects a concrete construction phase it cannot map into the neutral contract', async () => {
  const construction = {
    async prepare() { return { identity: IDENTITY }; },
    async status(identity) { return { identity, phase: 'foreign-phase' }; },
    async startInstall() { return { identity: IDENTITY }; },
    async bootInstalled() { return { identity: IDENTITY }; },
    async markQualified() { return { identity: IDENTITY }; },
    async retain() { return { identity: IDENTITY, location: 'retained-source' }; },
  };
  const qualification = { async probe() { return { ready: true }; }, async finalize() { return { finalized: true }; } };
  const foundation = { async publishImage() {}, async verifyImage() {} };
  const canary = createUbuntuProductionImageCanaryComposition({ journal: memoryJournal(), construction, qualification, foundation });
  await canary.advance(request());
  await assert.rejects(() => canary.advance(request()), /phase is unsupported/u);
});
