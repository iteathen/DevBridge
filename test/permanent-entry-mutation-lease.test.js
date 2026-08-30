import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMutationLease } from '../src/install/permanent-entry-installer/mutation-lease.mjs';

const PROTOCOL = 'test/mutation-lease-v1';

function fixture() {
  const root = path.join(tmpdir(), `devbridge-mutation-lease-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

function lease() {
  return createMutationLease({ protocol: PROTOCOL, fileName: '.activity' });
}

test('mutation lease observation reports absent, live, released, and dead state without mutation', () => {
  const selected = fixture();
  try {
    const api = lease();
    assert.deepEqual(api.observe(selected.root), { active: false });
    const release = api.acquire(selected.root);
    assert.deepEqual(api.observe(selected.root), { active: true });
    release();
    assert.deepEqual(api.observe(selected.root), { active: false });
    writeFileSync(path.join(selected.root, '.activity'), `${JSON.stringify({
      protocol: PROTOCOL,
      pid: 2147483647,
      startedAt: 1,
      token: '11111111-1111-4111-8111-111111111111',
    })}\n`, { flag: 'wx' });
    assert.deepEqual(api.observe(selected.root), { active: false });
  } finally { selected.close(); }
});

test('mutation lease observation rejects corrupt and indirect state', () => {
  const selected = fixture();
  try {
    const api = lease();
    writeFileSync(path.join(selected.root, 'foreign'), '{}\n');
    linkSync(path.join(selected.root, 'foreign'), path.join(selected.root, '.activity'));
    assert.throws(() => api.observe(selected.root), /invalid/u);
    rmSync(path.join(selected.root, '.activity'), { force: true });
    writeFileSync(path.join(selected.root, '.activity'), '{not-json}\n');
    assert.throws(() => api.observe(selected.root));
  } finally { selected.close(); }
});

test('mutation lease observer exposes only lease-local operations', () => {
  assert.deepEqual(Object.keys(lease()).sort(), ['acquire', 'observe']);
});
