import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSetupProtectedApplyFrontier } from '../src/setup/setup-protected-apply-frontier.js';

const CONFIGURATION = Object.freeze({ revision: 7, digest: 'a'.repeat(64) });
const SETUP = Object.freeze({
  protocol: 'devbridge/setup-status-v1',
  identity: Object.freeze({ id: 42, login: 'owner' }),
  repositories: Object.freeze({ selected: Object.freeze([{ id: 1, fullName: 'owner/repo', private: true }]) }),
  ubuntu: Object.freeze({ snapshot: '20260820T170000Z' }),
});

test('protected apply frontier advances one exact subject and resumes idempotently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-protected-apply-'));
  try {
    let clock = 0;
    const frontier = createSetupProtectedApplyFrontier({
      stateDirectory: directory,
      now: () => new Date(1_800_000_000_000 + clock++).toISOString(),
    });
    const prepared = await frontier.prepare(CONFIGURATION, 3, SETUP);
    const repeated = await frontier.prepare(CONFIGURATION, 3, SETUP);
    assert.equal(prepared.changed, true);
    assert.equal(repeated.changed, false);
    assert.equal(frontier.matches(await frontier.current(), CONFIGURATION, 3, SETUP, 'prepared'), true);

    const applied = await frontier.apply(CONFIGURATION, 3, SETUP);
    assert.equal(applied.record.revision, prepared.record.revision + 1);
    assert.equal(frontier.matches(await frontier.current(), CONFIGURATION, 3, SETUP, 'applied'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('protected apply frontier rejects stale configuration and profile-selection subjects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-protected-apply-stale-'));
  try {
    const frontier = createSetupProtectedApplyFrontier({ stateDirectory: directory });
    const prepared = (await frontier.prepare(CONFIGURATION, 3, SETUP)).record;
    assert.equal(frontier.matches(prepared, { revision: 8, digest: 'b'.repeat(64) }, 3, SETUP, 'prepared'), false);
    assert.equal(frontier.matches(prepared, CONFIGURATION, 4, SETUP, 'prepared'), false);
    assert.equal(frontier.matches(prepared, CONFIGURATION, 3, { ...SETUP, identity: { id: 43, login: 'other' } }, 'prepared'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('protected apply frontier owns no elevation, provider, network, or construction mechanism', async () => {
  const source = (await readFile(new URL('../src/setup/setup-protected-apply-frontier.js', import.meta.url), 'utf8')).toLowerCase();
  for (const identity of ['powershell', 'runas', 'github', 'provider', 'construction', 'child_process', 'fetch(']) {
    assert.equal(source.includes(identity), false, identity);
  }
});
