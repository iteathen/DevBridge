import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  reconcileWindowsElevatedSetupEnvironmentActivation,
  WINDOWS_ELEVATED_SETUP_ENVIRONMENT_ACTIVATION_PROTOCOL,
} from '../src/app/windows-elevated-setup-environment-activation.js';

const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const INVOKE = async () => {};
const HOST = Object.freeze({ elevated: true, operatorSid: 'S-1-5-21-1-2-3-1001', programData: 'C:\\ProgramData' });
const PLAN = Object.freeze({ authorityDirectory: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\owner\\state' });

function record(profiles = ['linux-development']) {
  return Object.freeze({
    configuration: Object.freeze({
      declarations: Object.freeze(profiles.map((profile) => Object.freeze({ profile }))),
    }),
  });
}

test('elevated activation stays a small orchestration LEGO over accepted configuration and lifecycle ports', async () => {
  const source = await readFile(new URL('../src/app/windows-elevated-setup-environment-activation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(?:fs|child_process)|providers\//iu);
  assert.doesNotMatch(source, /environment-lifecycle-authority-transport|createConfiguredLifecycleAuthorityClient/u);
  assert.doesNotMatch(source, /\b(?:construct|delete|rebuild|replace|retire|acl|service)\b/iu);
});

test('elevated activation derives every operation from accepted profiles and reuses one bounded local operator', async () => {
  const calls = [];
  const client = Object.freeze({ identity: 'client-a' });
  const result = await reconcileWindowsElevatedSetupEnvironmentActivation({
    stateDirectory: STATE,
    platform: 'win32',
    invoke: INVOKE,
    environment: Object.freeze({ SystemRoot: 'C:\\Windows' }),
  }, {
    hostInspector: async (request) => { calls.push(['host', request]); return HOST; },
    planFactory: (request) => { calls.push(['plan', request]); return PLAN; },
    recordReader: async (request) => {
      calls.push(['record', request]);
      return record(['linux-development', 'windows-development']);
    },
    configurationFactory: (request) => {
      calls.push(['configuration', request]);
      return Object.freeze({
        async reconcile() { calls.push(['configure']); return { ready: true, changed: false }; },
      });
    },
    operatorFactory: async (request) => {
      calls.push(['operator', request]);
      return client;
    },
    activationReconciler: async (request) => {
      calls.push(['activate', request]);
      return { ready: true, changed: request.profile === 'linux-development' };
    },
  });
  assert.deepEqual(result, {
    protocol: WINDOWS_ELEVATED_SETUP_ENVIRONMENT_ACTIVATION_PROTOCOL,
    ready: true,
    changed: true,
    blocker: null,
    environmentCount: 2,
  });
  assert.deepEqual(calls, [
    ['host', { invoke: INVOKE, environment: { SystemRoot: 'C:\\Windows' } }],
    ['plan', { stateDirectory: STATE, programDataDirectory: 'C:\\ProgramData', operatorSid: 'S-1-5-21-1-2-3-1001' }],
    ['configuration', { stateDirectory: STATE, platform: 'win32' }],
    ['configure'],
    ['record', { stateDirectory: STATE }],
    ['operator', { stateDirectory: STATE, authorityDirectory: PLAN.authorityDirectory, platform: 'win32', invoke: INVOKE }],
    ['activate', { client, profile: 'linux-development' }],
    ['activate', { client, profile: 'windows-development' }],
  ]);
});

test('elevated activation fails closed without an accepted non-empty configuration', async () => {
  for (const selected of [null, record([])]) {
    let operatorCreated = false;
    const result = await reconcileWindowsElevatedSetupEnvironmentActivation({ stateDirectory: STATE, platform: 'win32', invoke: INVOKE }, {
      hostInspector: async () => HOST,
      planFactory: () => PLAN,
      recordReader: async () => selected,
      configurationFactory: () => ({ reconcile: async () => ({ ready: true, changed: false }) }),
      operatorFactory: () => { operatorCreated = true; },
    });
    assert.equal(result.ready, false);
    assert.equal(result.changed, false);
    assert.equal(result.environmentCount, 0);
    assert.match(result.blocker, /configuration is unavailable/u);
    assert.equal(operatorCreated, false);
  }
});

test('elevated activation stops at the first non-ready accepted profile', async () => {
  const profiles = [];
  const result = await reconcileWindowsElevatedSetupEnvironmentActivation({ stateDirectory: STATE, platform: 'win32', invoke: INVOKE }, {
    hostInspector: async () => HOST,
    planFactory: () => PLAN,
    recordReader: async () => record(['linux-development', 'windows-development']),
    configurationFactory: () => ({ reconcile: async () => ({ ready: true, changed: false }) }),
    operatorFactory: () => Object.freeze({}),
    activationReconciler: async ({ profile }) => {
      profiles.push(profile);
      return profile === 'linux-development'
        ? { ready: true, changed: true }
        : { ready: false, changed: false, blocker: 'accepted environment is not safely creatable' };
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.equal(result.environmentCount, 1);
  assert.match(result.blocker, /not safely creatable/u);
  assert.deepEqual(profiles, ['linux-development', 'windows-development']);
});

test('elevated activation reconciles accepted configuration before lifecycle mutation', async () => {
  let recordRead = false;
  let operatorCreated = false;
  const result = await reconcileWindowsElevatedSetupEnvironmentActivation({ stateDirectory: STATE, platform: 'win32', invoke: INVOKE }, {
    hostInspector: async () => HOST,
    planFactory: () => PLAN,
    configurationFactory: () => ({ reconcile: async () => ({ ready: false, changed: true, blocker: 'configuration blocked' }) }),
    recordReader: async () => { recordRead = true; return record(); },
    operatorFactory: () => { operatorCreated = true; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.match(result.blocker, /configuration blocked/u);
  assert.equal(recordRead, false);
  assert.equal(operatorCreated, false);
});

test('elevated activation refuses a non-elevated host before protected configuration or lifecycle composition', async () => {
  let configured = false;
  let operatorCreated = false;
  const result = await reconcileWindowsElevatedSetupEnvironmentActivation({ stateDirectory: STATE, platform: 'win32', invoke: INVOKE }, {
    hostInspector: async () => ({ ...HOST, elevated: false }),
    configurationFactory: () => { configured = true; },
    operatorFactory: () => { operatorCreated = true; },
  });
  assert.equal(result.ready, false);
  assert.match(result.blocker, /bounded elevated setup child/u);
  assert.equal(configured, false);
  assert.equal(operatorCreated, false);
});

test('elevated activation rejects non-Windows and incomplete composition', async () => {
  await assert.rejects(
    reconcileWindowsElevatedSetupEnvironmentActivation({ stateDirectory: STATE, platform: 'linux', invoke: INVOKE }),
    /only valid on Windows/u,
  );
  await assert.rejects(
    reconcileWindowsElevatedSetupEnvironmentActivation({ stateDirectory: STATE, platform: 'win32', invoke: INVOKE }, { configurationFactory: null }),
    /composition is invalid/u,
  );
});
