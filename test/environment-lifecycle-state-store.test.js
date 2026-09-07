import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentDeclarationRegistry, ENVIRONMENT_DECLARATION_PROTOCOL } from '../src/runtime/environment-declaration.js';
import { EnvironmentLifecycleJournal } from '../src/runtime/environment-lifecycle-journal.js';
import { createEnvironmentLifecycleStateStore } from '../src/state/environment-lifecycle-state-store.js';

function declaration() {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'linux-development', schemaGeneration: 'profile-v1',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    image: { identity: 'image-ubuntu-2404-v1', generation: 'ubuntu-24.04.4-v1' },
    resources: { memoryBytes: 4294967296, processorCount: 4 },
    boot: { requirement: 'efi-v1' },
    network: { requirement: 'managed-egress-v1' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
    workspaces: [], protectedStateClasses: [],
  };
}

test('declarations and journal survive a fresh state-store instance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-lifecycle-'));
  const file = path.join(root, 'state.json');
  try {
    const firstStore = createEnvironmentLifecycleStateStore(file);
    const declarations = new EnvironmentDeclarationRegistry({ port: firstStore.declarations, now: () => '2026-08-22T07:00:00.000Z' });
    const registered = await declarations.register(declaration());
    const journal = new EnvironmentLifecycleJournal({ port: firstStore.journal, now: () => '2026-08-22T07:00:01.000Z', id: () => 'lifecycle-persisted-1' });
    await journal.begin({ environmentIdentity: registered.record.identity, operation: 'create', declarationRevision: registered.record.revision });

    const secondStore = createEnvironmentLifecycleStateStore(file);
    const reloadedDeclarations = new EnvironmentDeclarationRegistry({ port: secondStore.declarations });
    const reloadedJournal = new EnvironmentLifecycleJournal({ port: secondStore.journal });
    assert.equal((await reloadedDeclarations.get(registered.record.identity)).revision, 1);
    assert.equal((await reloadedJournal.active())[0].operationId, 'lifecycle-persisted-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('starting a replacement archives the complete failed journal before replacing current state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-lifecycle-history-'));
  const file = path.join(root, 'state.json');
  try {
    const store = createEnvironmentLifecycleStateStore(file);
    const declarations = new EnvironmentDeclarationRegistry({ port: store.declarations });
    const { record } = await declarations.register(declaration());
    const journal = new EnvironmentLifecycleJournal({ port: store.journal, id: () => 'lifecycle-old' });
    await journal.begin({ environmentIdentity: record.identity, operation: 'create', declarationRevision: 1 });
    const failed = await journal.advance(record.identity, 'lifecycle-old', { stage: 'terminal', outcome: 'failed', subjects: ['declaration-superseded'] });
    const next = new EnvironmentLifecycleJournal({ port: createEnvironmentLifecycleStateStore(file).journal, id: () => 'lifecycle-new' });
    await next.begin({ environmentIdentity: record.identity, operation: 'rebuild', declarationRevision: 2 });
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(raw['journal-history:lifecycle-old'], failed);
    assert.equal((await next.active()).length, 1);
    assert.equal((await next.current(record.identity)).operationId, 'lifecycle-new');
  } finally { await rm(root, { recursive: true, force: true }); }
});
