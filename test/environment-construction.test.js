import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DECLARATION_PROTOCOL, logicalEnvironmentIdentity } from '../src/runtime/environment-declaration.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';
import { ENVIRONMENT_CONSTRUCTION_STAGES, EnvironmentConstructionPipeline } from '../src/runtime/environment-construction.js';

function declaration() { return { protocol: ENVIRONMENT_DECLARATION_PROTOCOL, profile: 'linux-development', schemaGeneration: 'profile-v1', guest: { family: 'ubuntu', generation: '24.04.4' }, image: { identity: 'image-ubuntu-v1', generation: 'ubuntu-v1' }, resources: { memoryBytes: 4294967296, processorCount: 4 }, boot: { requirement: 'efi-v1' }, network: { requirement: 'managed-egress-v1' }, bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] }, enrollment: { requirement: 'unique-guest-trust-v1' }, workspaces: [{ identity: 'workspace-a', authority: 'authority-a' }], protectedStateClasses: [] }; }
function observation(identity, revision, generation, overrides = {}) { return { protocol: ENVIRONMENT_OBSERVATION_PROTOCOL, environmentIdentity: identity, declarationRevision: revision, implementationGeneration: generation, materialization: 'present', systemStorage: 'present', attachment: 'ready', enrollment: 'ready', bootstrap: 'ready', guest: 'healthy', transition: 'clear', ...overrides }; }
function checkpointPort() { const values = new Map(); return { values, async load(key) { return structuredClone(values.get(key) ?? null); }, async save(key, value) { values.set(key, structuredClone(value)); }, async delete(key) { values.delete(key); } }; }
function input() { const value = declaration(); return { environmentIdentity: logicalEnvironmentIdentity(value.profile), operationId: 'lifecycle-operation-1', declarationRevision: 1, declaration: value }; }

function stagePorts(request, events, generation, failure = null, changedGenerationStage = null) {
  const result = async (stage, value) => {
    events.push(stage);
    if (failure?.stage === stage && failure.triggered !== true) {
      failure.triggered = true;
      throw new Error(`interrupted at ${stage}`);
    }
    return value;
  };
  const selectedGeneration = (stage) => changedGenerationStage === stage ? 'implementation-generation-2' : generation;
  return {
    image: { ensure: async () => result('image', { ready: true }) },
    resources: { ensure: async () => result('resources', { ready: true }) },
    materialization: { ensure: async () => result('materialization', { ready: true, implementationGeneration: generation }) },
    preparation: { ensure: async () => result('preparation', { ready: true, implementationGeneration: selectedGeneration('preparation') }) },
    workspaces: { ensure: async () => result('workspaces', { ready: true, implementationGeneration: selectedGeneration('workspaces') }) },
    readiness: { verify: async () => {
      const selected = selectedGeneration('readiness');
      return result('readiness', { ready: true, implementationGeneration: selected, observation: observation(request.environmentIdentity, request.declarationRevision, selected) });
    } },
  };
}

test('construction runs neutral stages in order and checkpoints readiness', async () => { const request = input(); const events = []; const checkpoint = checkpointPort(); const generation = 'implementation-generation-1'; const pipeline = new EnvironmentConstructionPipeline({ checkpoint, image: { ensure: async () => { events.push('image'); return { ready: true }; } }, resources: { ensure: async () => { events.push('resources'); return { ready: true }; } }, materialization: { ensure: async () => { events.push('materialization'); return { ready: true, implementationGeneration: generation }; } }, preparation: { ensure: async () => { events.push('preparation'); return { ready: true, implementationGeneration: generation }; } }, workspaces: { ensure: async () => { events.push('workspaces'); return { ready: true, implementationGeneration: generation }; } }, readiness: { verify: async () => { events.push('readiness'); return { ready: true, implementationGeneration: generation, observation: observation(request.environmentIdentity, 1, generation) }; } }, now: () => '2026-08-22T08:30:00.000Z' }); const result = await pipeline.run(request); assert.deepEqual(events, ENVIRONMENT_CONSTRUCTION_STAGES); assert.equal(result.state, 'ready'); assert.equal(result.implementationGeneration, generation); assert.deepEqual(checkpoint.values.get(request.operationId).completed, ENVIRONMENT_CONSTRUCTION_STAGES); });

test('construction resumes after an interrupted stage without replaying completed stages', async () => { const request = input(); const events = []; const checkpoint = checkpointPort(); const generation = 'implementation-generation-1'; let fail = true; const pipeline = new EnvironmentConstructionPipeline({ checkpoint, image: { ensure: async () => { events.push('image'); return { ready: true }; } }, resources: { ensure: async () => { events.push('resources'); return { ready: true }; } }, materialization: { ensure: async () => { events.push('materialization'); return { ready: true, implementationGeneration: generation }; } }, preparation: { ensure: async () => { events.push('preparation'); if (fail) { fail = false; throw new Error('interrupted'); } return { ready: true, implementationGeneration: generation }; } }, workspaces: { ensure: async () => { events.push('workspaces'); return { ready: true, implementationGeneration: generation }; } }, readiness: { verify: async () => ({ ready: true, implementationGeneration: generation, observation: observation(request.environmentIdentity, 1, generation) }) } }); await assert.rejects(() => pipeline.run(request), /interrupted/u); assert.deepEqual(checkpoint.values.get(request.operationId).completed, ['image', 'resources', 'materialization']); events.length = 0; await pipeline.run(request); assert.deepEqual(events, ['preparation', 'workspaces']); });

test('construction rejects stale checkpoint authority and unhealthy readiness', async () => { const request = input(); const checkpoint = checkpointPort(); const generation = 'implementation-generation-1'; const ports = { image: { ensure: async () => ({ ready: true }) }, resources: { ensure: async () => ({ ready: true }) }, materialization: { ensure: async () => ({ ready: true, implementationGeneration: generation }) }, preparation: { ensure: async () => ({ ready: true, implementationGeneration: generation }) }, workspaces: { ensure: async () => ({ ready: true, implementationGeneration: generation }) }, readiness: { verify: async () => ({ ready: true, implementationGeneration: generation, observation: observation(request.environmentIdentity, 1, generation, { guest: 'degraded' }) }) } }; const pipeline = new EnvironmentConstructionPipeline({ checkpoint, ...ports }); await assert.rejects(() => pipeline.run(request), /not healthy/u); await assert.rejects(() => pipeline.run({ ...request, declarationRevision: 2 }), /checkpoint no longer matches/u); });

test('construction reconciles interruption at every durable stage without replaying checkpointed stages', async () => {
  for (const failedStage of ENVIRONMENT_CONSTRUCTION_STAGES) {
    const request = { ...input(), operationId: `operation-interrupt-${failedStage}` };
    const events = [];
    const checkpoint = checkpointPort();
    const generation = 'implementation-generation-1';
    const failure = { stage: failedStage, triggered: false };
    const pipeline = new EnvironmentConstructionPipeline({ checkpoint, ...stagePorts(request, events, generation, failure) });
    await assert.rejects(() => pipeline.run(request), new RegExp(`interrupted at ${failedStage}`, 'u'));
    const failedIndex = ENVIRONMENT_CONSTRUCTION_STAGES.indexOf(failedStage);
    assert.deepEqual(checkpoint.values.get(request.operationId)?.completed ?? [], ENVIRONMENT_CONSTRUCTION_STAGES.slice(0, failedIndex));
    events.length = 0;
    const result = await pipeline.run(request);
    assert.equal(result.state, 'ready');
    assert.deepEqual(events, ENVIRONMENT_CONSTRUCTION_STAGES.slice(failedIndex));
    assert.deepEqual(checkpoint.values.get(request.operationId).completed, ENVIRONMENT_CONSTRUCTION_STAGES);
  }
});

test('construction refuses implementation-generation drift after materialization', async () => {
  for (const changedStage of ['preparation', 'workspaces', 'readiness']) {
    const request = { ...input(), operationId: `operation-generation-drift-${changedStage}` };
    const pipeline = new EnvironmentConstructionPipeline({
      checkpoint: checkpointPort(),
      ...stagePorts(request, [], 'implementation-generation-1', null, changedStage),
    });
    await assert.rejects(() => pipeline.run(request), /implementation generation changed/u);
  }
});
