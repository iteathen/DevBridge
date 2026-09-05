import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcileSerialSelection } from '../src/setup/serial-reconciliation.js';

test('serial reconciliation returns after one changed item and resumes in fixed input order', async () => {
  const calls = [];
  const result = await reconcileSerialSelection({
    items: ['profile-a', 'profile-b'],
    async reconcile(item) {
      calls.push(item);
      return item === 'profile-a'
        ? { ready: true, changed: true, blocker: null }
        : { ready: true, changed: false, blocker: null };
    },
  });
  assert.deepEqual(calls, ['profile-a']);
  assert.deepEqual(result, {
    ready: false, changed: true, state: 'pending', item: 'profile-a', completedCount: 1, totalCount: 2, blocker: null,
  });

  const resumed = await reconcileSerialSelection({
    items: ['profile-a', 'profile-b'],
    async reconcile(item) {
      return item === 'profile-a'
        ? { ready: true, changed: false, blocker: null }
        : { ready: true, changed: true, blocker: null };
    },
  });
  assert.deepEqual(resumed, {
    ready: true, changed: true, state: 'ready', item: 'profile-b', completedCount: 2, totalCount: 2, blocker: null,
  });
});

test('serial reconciliation never skips a blocker and reports mutation-before-block evidence', async () => {
  const calls = [];
  const result = await reconcileSerialSelection({
    items: ['profile-a', 'profile-b'],
    async reconcile(item) {
      calls.push(item);
      return { ready: false, changed: item === 'profile-a', blocker: 'bounded blocker' };
    },
  });
  assert.deepEqual(calls, ['profile-a']);
  assert.deepEqual(result, {
    ready: false, changed: true, state: 'blocked', item: 'profile-a', completedCount: 0, totalCount: 2, blocker: 'bounded blocker',
  });
});

test('serial reconciliation reports an all-ready mutation-free selection', async () => {
  const result = await reconcileSerialSelection({
    items: ['profile-a', 'profile-b'],
    reconcile: async () => ({ ready: true, changed: false, blocker: null }),
  });
  assert.deepEqual(result, {
    ready: true, changed: false, state: 'ready', item: null, completedCount: 2, totalCount: 2, blocker: null,
  });
});

test('serial reconciliation rejects widened, contradictory, duplicate, and unbounded input', async () => {
  await assert.rejects(() => reconcileSerialSelection({ items: [], reconcile: async () => ({}) }), /items are invalid/u);
  await assert.rejects(() => reconcileSerialSelection({ items: ['a', 'a'], reconcile: async () => ({}) }), /duplicates/u);
  await assert.rejects(() => reconcileSerialSelection({
    items: ['a'], reconcile: async () => ({ ready: true, changed: false, blocker: 'contradiction' }),
  }), /inconsistent/u);
  await assert.rejects(() => reconcileSerialSelection({
    items: ['a'], reconcile: async () => ({ ready: true, changed: false, blocker: null, target: 'foreign' }),
  }), /target is not allowed/u);
});

test('serial reconciliation contains no current topology or effect identities', async () => {
  const source = await readFile(new URL('../src/setup/serial-reconciliation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /windows|linux|ubuntu|hyper-?v|libvirt|qemu|repository|workspace|provider|virtual.?machine|\.run\(|\.resume\(/iu);
});
