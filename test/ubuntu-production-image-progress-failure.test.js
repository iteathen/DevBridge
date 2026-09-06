import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressCoordinator } from '../src/app/ubuntu-production-image-physical-canary/progress-coordinator.js';

function fixture(state, collection = 'available') {
  const failure = Object.freeze({ stage: 'apt-install', exitCode: 100, stdout: '', stderr: 'unmet dependencies', truncated: false });
  let advances = 0;
  let captures = 0;
  const coordinator = createProgressCoordinator({
    maximumAdvances: 2,
    measureReadiness: () => ({ classification: 'waiting' }),
    messages: {
      evidenceUnavailable: 'evidence unavailable', progressing: 'progressing', slow: 'slow',
      progressPending: 'pending', progressUnavailable: 'progress unavailable',
      outputNotReady: 'not ready', shutdownPending: 'shutdown pending', advancementLimit: 'limit',
      progressBlocked: value => value, lifecyclePending: value => value,
      endpointNotReady: value => value, endpointUnready: value => value, readinessExpired: value => value,
    },
  });
  return {
    failure,
    advances: () => advances,
    captures: () => captures,
    run: () => coordinator.run({
      inspect: async () => ({ phase: 'running', complete: false, blocked: false }),
      advance: async () => { advances += 1; return { blocked: false }; },
      observeProgress: async () => ({
        state, mediaCount: state === 'running' ? 2 : 0,
        liveness: { classification: 'progressing', diskGrowthBytes: 1024 * 1024 },
        installationEvidence: { failure, collection: { status: collection } },
      }),
      observeLifecycle: async () => { throw new Error('failed installation must not probe the next lifecycle phase'); },
      resolveEndpoint: async () => { throw new Error('failed installation must not resolve guest access'); },
      inspectEndpoint: async () => { throw new Error('failed installation must not inspect guest access'); },
      captureEvidence: async () => { captures += 1; throw new Error('saved terminal evidence must not depend on another capture'); },
      reconcileCompletion: async () => { throw new Error('failed installation is not complete'); },
      present: async (current, details) => ({ ...current, ...details }),
    }),
  };
}

test('saved installer failure wins over a running VM and growing disk without another capture', async () => {
  const subject = fixture('running');
  const result = await subject.run();
  assert.equal(result.state, 'blocked');
  assert.match(result.reason, /apt-install.*100/u);
  assert.equal(result.installationEvidence.failure.stderr, 'unmet dependencies');
  assert.equal(subject.advances(), 0);
  assert.equal(subject.captures(), 0);
});

test('saved installer failure forbids installed boot even after VM poweroff and collector loss', async () => {
  const subject = fixture('off', 'unavailable');
  const result = await subject.run();
  assert.equal(result.state, 'blocked');
  assert.equal(result.installationEvidence.collection.status, 'unavailable');
  assert.deepEqual(result.installationEvidence.failure, subject.failure);
  assert.equal(subject.advances(), 0);
  assert.equal(subject.captures(), 0);
});
