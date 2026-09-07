import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSetupResourceConflictObservation,
  setupResourceConflictConsent,
} from '../src/setup/resource-conflict.js';
import { createSetupResourceConflictConsentStore } from '../src/state/setup-resource-conflict-consent-store.js';

test('resource conflict values expose only neutral bounded subjects', () => {
  const subject = 'a'.repeat(64);
  assert.deepEqual(normalizeSetupResourceConflictObservation({
    protocol: 'devbridge/setup-resource-conflict-v1',
    state: 'approval-required',
    subject,
    reason: 'one inactive local resource blocks setup',
  }), {
    protocol: 'devbridge/setup-resource-conflict-v1',
    state: 'approval-required',
    subject,
    reason: 'one inactive local resource blocks setup',
  });
  assert.deepEqual(setupResourceConflictConsent(subject), {
    protocol: 'devbridge/setup-resource-conflict-consent-v1',
    subject,
  });
  assert.throws(() => normalizeSetupResourceConflictObservation({
    protocol: 'devbridge/setup-resource-conflict-v1',
    state: 'approval-required',
    subject,
    reason: 'bounded',
    resourceName: 'foreign-name',
  }), /resourceName is not allowed/u);
});

test('resource conflict consent persists as one exact bounded record and clears idempotently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-resource-consent-'));
  try {
    const store = createSetupResourceConflictConsentStore({ stateDirectory: root });
    assert.equal(await store.load(), null);
    const consent = setupResourceConflictConsent('b'.repeat(64));
    await store.save(consent);
    assert.deepEqual(await store.load(), consent);
    assert.equal(await store.clear(), true);
    assert.equal(await store.clear(), false);
    assert.equal(await store.load(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resource conflict consent rejects an oversized or malformed record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-resource-consent-invalid-'));
  try {
    const store = createSetupResourceConflictConsentStore({ stateDirectory: root });
    await store.save(setupResourceConflictConsent('c'.repeat(64)));
    const file = path.join(root, 'setup-resource-conflict', 'consent.json');
    await writeFile(file, 'x'.repeat(2049), 'utf8');
    await assert.rejects(store.load(), /one bounded real file/u);
    await writeFile(file, '{}\n', 'utf8');
    await assert.rejects(store.load(), /protocol is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
