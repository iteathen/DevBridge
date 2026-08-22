import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentRepairCorrection, createEnvironmentRecoveryEvidence } from '../src/app/environment-recovery.js';

function request(cause) {
  const declaration = { enrollment: { requirement: 'unique-guest-trust-v1' }, bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] }, workspaces: [] };
  return { environmentIdentity: 'environment-1', operationId: 'operation-1', declarationRevision: 1, declaration, implementationGeneration: 'implementation-1', cause };
}

test('repair correction routes only explicit preservation-safe causes', async () => {
  const events = [];
  const correction = createEnvironmentRepairCorrection({
    foundation: { reconcile: async () => { events.push('reconcile'); }, ensureNetwork: async () => { events.push('network'); return { ready: true }; } },
    materialization: { ensure: async () => { events.push('materialization'); return { ready: true, implementationGeneration: 'implementation-1' }; } },
    preparation: { ensure: async () => { events.push('preparation'); return { ready: true, implementationGeneration: 'implementation-1' }; } },
    workspaces: { ensure: async () => { events.push('workspaces'); return { ready: true, implementationGeneration: 'implementation-1' }; } },
  });
  await correction.ensure(request('transition-incomplete'));
  await correction.ensure(request('attachment-invalid'));
  await correction.ensure(request('bootstrap-degraded'));
  await correction.ensure(request('network-degraded'));
  await correction.ensure(request('workspace-degraded'));
  assert.deepEqual(events, ['reconcile', 'materialization', 'preparation', 'network', 'preparation', 'preparation', 'workspaces']);
  await assert.rejects(() => correction.ensure(request('system-storage-missing')), /does not support cause/u);
});

test('repair correction rejects an implementation-generation change', async () => {
  const correction = createEnvironmentRepairCorrection({
    foundation: { reconcile: async () => {}, ensureNetwork: async () => ({ ready: true }) },
    materialization: { ensure: async () => ({ ready: true, implementationGeneration: 'replacement-generation' }) },
    preparation: { ensure: async () => ({ ready: true, implementationGeneration: 'implementation-1' }) },
    workspaces: { ensure: async () => ({ ready: true, implementationGeneration: 'implementation-1' }) },
  });
  await assert.rejects(() => correction.ensure(request('attachment-invalid')), /preserve the implementation generation/u);
});

test('recovery evidence reports neutral resource, network, and workspace readiness', async () => {
  const evidence = createEnvironmentRecoveryEvidence({
    foundation: { inspect: async () => ({ capabilities: { management: { ready: true }, storage: { ready: true }, networking: { ready: true } } }) },
    preparation: { inspect: async () => ({ ready: false, network: 'degraded' }) },
    workspaces: { inspect: async () => ({ ready: false }) },
  });
  const record = { identity: 'environment-1', revision: 1, declaration: { enrollment: {}, bootstrap: {}, workspaces: [] } };
  const result = await evidence.inspect({ record, observation: { materialization: 'present', implementationGeneration: 'implementation-1' } });
  assert.deepEqual(result, { resources: 'ready', network: 'degraded', workspaces: 'degraded' });
});
