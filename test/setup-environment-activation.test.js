import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcileSetupEnvironmentActivation } from '../src/app/setup-environment-activation.js';
import { ENVIRONMENT_OPERATOR_STATUS_PROTOCOL } from '../src/app/environment-operator.js';

const PROFILE = 'profile-a';
const IDENTITY = 'environment-a';

test('setup activation remains isolated from provider, repository, and transport topology', async () => {
  const source = await readFile(new URL('../src/app/setup-environment-activation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:windows|linux|ubuntu|hyper-v|libvirt|repository|workspace|bridge|socket|pipe|vhdx|qcow2|credential)\b/iu);
  assert.doesNotMatch(source, /node:(?:fs|path|child_process)|providers\//iu);
});

function status({
  profile = PROFILE,
  identity = IDENTITY,
  health = 'ready',
  cause = 'healthy',
  action = 'none',
  active = false,
  operation = null,
  resumable = false,
  observed = null,
} = {}) {
  return Object.freeze({
    protocol: ENVIRONMENT_OPERATOR_STATUS_PROTOCOL,
    environmentIdentity: identity,
    profile,
    health: Object.freeze({ state: health, cause }),
    lifecycle: Object.freeze({ active, operation, resumable }),
    recommendedAction: action,
    observed: observed ?? (health === 'ready' ? Object.freeze({
      implementationGeneration: 'generation-a',
      materialization: 'present',
      systemStorage: 'present',
      attachment: 'ready',
      enrollment: 'ready',
      bootstrap: 'ready',
      guest: 'healthy',
      transition: 'clear',
    }) : null),
  });
}

function client({ before, after = null, inventory = null } = {}) {
  const calls = [];
  return {
    calls,
    value: {
      async list() { calls.push(['list']); return inventory ?? [before]; },
      async status(identity) { calls.push(['status', identity]); return after ?? before; },
      async run(operation, identity) { calls.push(['run', operation, identity]); return { state: 'complete' }; },
      async resume(identity) { calls.push(['resume', identity]); return { state: 'complete' }; },
    },
  };
}

test('setup activation treats one exact healthy environment as a mutation-free no-op', async () => {
  const selected = client({ before: status() });
  const result = await reconcileSetupEnvironmentActivation({ client: selected.value, profile: PROFILE });
  assert.equal(result.ready, true);
  assert.equal(result.changed, false);
  assert.equal(result.environmentCount, 1);
  assert.deepEqual(selected.calls, [['list']]);
});

test('setup activation creates only an exact absent accepted environment and verifies it afterward', async () => {
  const selected = client({
    before: status({ health: 'absent', cause: 'materialization-not-created', action: 'create' }),
    after: status(),
  });
  const result = await reconcileSetupEnvironmentActivation({ client: selected.value, profile: PROFILE });
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.deepEqual(selected.calls, [
    ['list'],
    ['run', 'create', IDENTITY],
    ['status', IDENTITY],
  ]);
});

test('setup activation resumes only an interrupted create through the existing lifecycle owner', async () => {
  const selected = client({
    before: status({
      health: 'absent',
      cause: 'materialization-not-created',
      action: 'resume',
      active: true,
      operation: 'create',
      resumable: true,
    }),
    after: status(),
  });
  const result = await reconcileSetupEnvironmentActivation({ client: selected.value, profile: PROFILE });
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.deepEqual(selected.calls, [['list'], ['resume', IDENTITY], ['status', IDENTITY]]);
});

test('setup activation fails closed on absent or ambiguous profile inventory', async () => {
  for (const inventory of [[], [status(), status({ identity: 'environment-b' })]]) {
    const selected = client({ before: status(), inventory });
    const result = await reconcileSetupEnvironmentActivation({ client: selected.value, profile: PROFILE });
    assert.equal(result.ready, false);
    assert.match(result.blocker, /unavailable or ambiguous/u);
    assert.deepEqual(selected.calls, [['list']]);
  }
});

test('setup activation does not broaden a foreign or destructive active transition', async () => {
  const selected = client({
    before: status({ health: 'degraded', cause: 'system-storage-missing', action: 'resume', active: true, operation: 'rebuild', resumable: true }),
  });
  const result = await reconcileSetupEnvironmentActivation({ client: selected.value, profile: PROFILE });
  assert.equal(result.ready, false);
  assert.match(result.blocker, /non-create lifecycle transition/u);
  assert.deepEqual(selected.calls, [['list']]);
});

test('setup activation refuses an ordinary degraded state instead of selecting a repair', async () => {
  const selected = client({ before: status({ health: 'degraded', cause: 'bootstrap-degraded', action: 'repair' }) });
  const result = await reconcileSetupEnvironmentActivation({ client: selected.value, profile: PROFILE });
  assert.equal(result.ready, false);
  assert.match(result.blocker, /not safely creatable/u);
  assert.deepEqual(selected.calls, [['list']]);
});

test('setup activation independently rejects an incomplete or substituted final status', async () => {
  const incomplete = client({
    before: status({ health: 'absent', cause: 'materialization-not-created', action: 'create' }),
    after: status({ observed: {
      implementationGeneration: 'generation-a',
      materialization: 'present',
      systemStorage: 'present',
      attachment: 'ready',
      enrollment: 'ready',
      bootstrap: 'ready',
      guest: 'unreachable',
      transition: 'clear',
    } }),
  });
  const result = await reconcileSetupEnvironmentActivation({ client: incomplete.value, profile: PROFILE });
  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.match(result.blocker, /did not verify ready/u);

  const substituted = client({
    before: status({ health: 'absent', cause: 'materialization-not-created', action: 'create' }),
    after: status({ identity: 'environment-b' }),
  });
  await assert.rejects(
    () => reconcileSetupEnvironmentActivation({ client: substituted.value, profile: PROFILE }),
    /identity changed/u,
  );
});

test('setup activation rejects malformed protected status instead of interpreting it', async () => {
  const selected = client({ before: { profile: PROFILE, environmentIdentity: IDENTITY } });
  await assert.rejects(
    () => reconcileSetupEnvironmentActivation({ client: selected.value, profile: PROFILE }),
    /does not match the accepted profile/u,
  );
});
