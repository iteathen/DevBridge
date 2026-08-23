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

test('production composition maps concrete studs only at the topology edge', async () => {
  const calls = [];
  const construction = {
    async prepare(input) { calls.push(['prepare', input]); return { identity: IDENTITY }; },
    async status(identity) { calls.push(['status', identity]); return { identity }; },
    async startInstall(identity) { calls.push(['startInstall', identity]); return { identity }; },
    async bootInstalled(identity) { calls.push(['bootInstalled', identity]); return { identity }; },
    async markQualified(identity, evidence) { calls.push(['markQualified', identity, evidence]); return { identity }; },
    async retain(identity) { calls.push(['retain', identity]); return { identity, location: 'retained-source' }; },
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

  assert.deepEqual(calls.map(([name]) => name), [
    'prepare', 'startInstall', 'bootInstalled', 'probe', 'finalize', 'markQualified',
    'retain', 'retain', 'publishImage', 'verifyImage',
  ]);
  const publication = calls.find(([name]) => name === 'publishImage')[1];
  assert.equal(publication.source, 'retained-source');
  assert.deepEqual(publication.provenance, { origin: 'production-canary' });
});
