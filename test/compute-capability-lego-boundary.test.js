import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COMPUTE_CAPABILITY_PROTOCOL,
  COMPUTE_CAPABILITY_STATUS,
  COMPUTE_REQUIREMENT_PROTOCOL,
  COMPUTE_TOPOLOGY,
  matchComputeCapability,
} from '../src/runtime/compute-capabilities.js';

function requirement() {
  return {
    protocol: COMPUTE_REQUIREMENT_PROTOCOL,
    api: 'accelerator-api',
    features: ['feature-a'],
    evidence: ['functional'],
    topology: COMPUTE_TOPOLOGY.HOST_RETAINED,
  };
}

function capability(subject) {
  return {
    protocol: COMPUTE_CAPABILITY_PROTOCOL,
    subject,
    generation: 'generation-a',
    profile: 'profile-a',
    environment: { identity: 'environment-a', generation: 'environment-generation-a' },
    api: 'accelerator-api',
    features: ['feature-a'],
    evidence: ['functional'],
    topology: COMPUTE_TOPOLOGY.HOST_RETAINED,
    status: COMPUTE_CAPABILITY_STATUS.QUALIFIED,
    qualification: { identity: 'qualification-a', generation: 'qualification-generation-a' },
    blocker: null,
  };
}

const context = {
  profile: 'profile-a',
  environment: { identity: 'environment-a', generation: 'environment-generation-a' },
};

test('neutral matcher is adapter replaceable and depends only on declared capability facts', () => {
  const first = matchComputeCapability(requirement(), capability('adapter-a-capability'), context);
  const second = matchComputeCapability(requirement(), capability('adapter-b-capability'), context);
  assert.equal(first.matched, true);
  assert.equal(second.matched, true);
  assert.notEqual(first.capability.subject, second.capability.subject);
});

test('generic compute LEGO has no runtime dependency on provider or repository modules', async () => {
  const source = await readFile(new URL('../src/runtime/compute-capabilities.js', import.meta.url), 'utf8');
  assert.equal(/^import\s/mu.test(source), false);
  assert.equal(source.includes('repository'), false);
  assert.equal(source.includes('workspace'), false);
});
