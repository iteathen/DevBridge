import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { selectSerialProfileAction } from '../src/setup/serial-profile-action.js';

const policy = { order: ['profile-a', 'profile-b'] };
const observation = (profile, { complete = false, blocked = false, reason = null } = {}) => ({ profile, complete, blocked, reason });

test('serial action selects only the first incomplete profile in policy order', () => {
  assert.deepEqual(selectSerialProfileAction({
    profiles: ['profile-b', 'profile-a'],
    observations: [observation('profile-b'), observation('profile-a')],
  }, policy), { state: 'ready', profile: 'profile-a', reason: null });

  assert.deepEqual(selectSerialProfileAction({
    profiles: ['profile-a', 'profile-b'],
    observations: [observation('profile-a', { complete: true }), observation('profile-b')],
  }, policy), { state: 'ready', profile: 'profile-b', reason: null });
});

test('serial action stops at the first blocker and reports all-complete state', () => {
  assert.deepEqual(selectSerialProfileAction({
    profiles: ['profile-a', 'profile-b'],
    observations: [
      observation('profile-a', { blocked: true, reason: 'first frontier unavailable' }),
      observation('profile-b'),
    ],
  }, policy), { state: 'blocked', profile: 'profile-a', reason: 'first frontier unavailable' });

  assert.deepEqual(selectSerialProfileAction({
    profiles: ['profile-a', 'profile-b'],
    observations: [observation('profile-a', { complete: true }), observation('profile-b', { complete: true })],
  }, policy), { state: 'complete', profile: null, reason: null });
  assert.deepEqual(selectSerialProfileAction({ profiles: [], observations: [] }, policy), {
    state: 'complete', profile: null, reason: null,
  });
});

test('serial action fails closed on missing, foreign, contradictory, and widened observations', () => {
  assert.deepEqual(selectSerialProfileAction({ profiles: ['profile-a'], observations: [] }, policy), {
    state: 'blocked', profile: 'profile-a', reason: 'selected profile observation is unavailable',
  });
  assert.throws(() => selectSerialProfileAction({
    profiles: ['profile-a'], observations: [observation('profile-b')],
  }, policy), /observation profile is invalid/u);
  assert.throws(() => selectSerialProfileAction({
    profiles: ['profile-a'], observations: [observation('profile-a', { complete: true, blocked: true, reason: 'bad' })],
  }, policy), /observation state is invalid/u);
  assert.throws(() => selectSerialProfileAction({
    profiles: ['profile-a'], observations: [{ ...observation('profile-a'), command: 'run' }],
  }, policy), /command is not allowed/u);
  assert.throws(() => selectSerialProfileAction({ profiles: ['profile-a'], observations: [] }, { order: ['profile-b'] }), /does not cover/u);
});

test('serial action policy contains no current topology or effect identities', async () => {
  const source = await readFile(new URL('../src/setup/serial-profile-action.js', import.meta.url), 'utf8');
  for (const forbidden of ['linux', 'windows', 'provider', 'hyper-v', 'libvirt', 'repository', 'virtual machine', 'media', 'canary', 'command', 'execute']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /^import\s/mu);
});
