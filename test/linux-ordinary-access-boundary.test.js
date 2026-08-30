import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  observeOrdinaryAccessBoundary,
  ORDINARY_ACCESS_BOUNDARY_PROTOCOL,
} from '../src/setup/linux-ordinary-access-boundary.js';

const IDENTITY = '/var/lib/devbridge/authority/state';

function ports(overrides = {}) {
  const identity = Object.freeze({ identity: IDENTITY, deviceId: 1, objectId: 2, mode: 0o40700, ownerId: 995, groupId: 0 });
  return {
    readPlatform: async () => 'linux',
    readRealIdentityId: async () => 1000,
    readEffectiveIdentityId: async () => 1000,
    observeIdentity: async () => identity,
    acquire: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
    ...overrides,
  };
}

test('actual permission denial is the only ready access-boundary evidence', async () => {
  let request = null;
  const observed = await observeOrdinaryAccessBoundary({ identity: IDENTITY, principalId: 1000 }, ports({
    acquire: async (value) => { request = value; const error = new Error('denied'); error.code = 'EPERM'; throw error; },
  }));
  assert.deepEqual(observed, {
    protocol: ORDINARY_ACCESS_BOUNDARY_PROTOCOL,
    platform: 'linux',
    applicable: true,
    ready: true,
    reason: null,
  });
  assert.equal(request.identity, IDENTITY);
  assert.equal(Number.isInteger(request.flags), true);
});

test('an acquired descriptor is released and proves direct access rather than readiness', async () => {
  let releases = 0;
  const observed = await observeOrdinaryAccessBoundary({ identity: IDENTITY, principalId: 1000 }, ports({
    acquire: async () => Object.freeze({ release: async () => { releases += 1; } }),
  }));
  assert.equal(releases, 1);
  assert.equal(observed.ready, false);
  assert.equal(observed.reason, 'direct-access-present');
});

test('principal mismatch, indirection-shaped errors, and widened ports fail closed', async () => {
  let acquired = false;
  const mismatch = await observeOrdinaryAccessBoundary({ identity: IDENTITY, principalId: 1000 }, ports({
    readEffectiveIdentityId: async () => 0,
    acquire: async () => { acquired = true; },
  }));
  assert.equal(mismatch.reason, 'principal-mismatch');
  assert.equal(acquired, false);

  const invalid = await observeOrdinaryAccessBoundary({ identity: IDENTITY, principalId: 1000 }, ports({
    acquire: async () => { const error = new Error('link'); error.code = 'ELOOP'; throw error; },
  }));
  assert.equal(invalid.reason, 'identity-invalid');

  let observations = 0;
  const changed = await observeOrdinaryAccessBoundary({ identity: IDENTITY, principalId: 1000 }, ports({
    observeIdentity: async () => Object.freeze({ identity: IDENTITY, deviceId: 1, objectId: ++observations, mode: 0o40700, ownerId: 995, groupId: 0 }),
  }));
  assert.equal(changed.reason, 'identity-changed');
  await assert.rejects(() => observeOrdinaryAccessBoundary({ identity: IDENTITY, principalId: 1000 }, { ...ports(), executable: '/bin/foreign' }));
});

test('production Linux descriptor probe distinguishes a real unreadable directory without mutation', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-access-boundary-'));
  const target = path.join(root, 'protected');
  await mkdir(target, { mode: 0o700 });
  try {
    const direct = await observeOrdinaryAccessBoundary({ identity: target, principalId: process.getuid() });
    assert.equal(direct.ready, false);
    assert.equal(direct.reason, 'direct-access-present');
    await chmod(target, 0o000);
    const denied = await observeOrdinaryAccessBoundary({ identity: target, principalId: process.getuid() });
    assert.equal(denied.ready, true);
    assert.equal(denied.reason, null);
  } finally {
    await chmod(target, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
