import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrateWindowsLifecycleAuthorityState,
  probeWindowsLifecycleAuthority,
  reconcileWindowsLifecycleAuthorityService,
  WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROTOCOL,
  WINDOWS_LIFECYCLE_AUTHORITY_STATE_PATHS,
} from '../src/setup/windows-lifecycle-authority-service.js';

const SERVICE_SOURCE = fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-service.js', import.meta.url));
const OPERATOR_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const PACKAGE_DIGEST = 'a'.repeat(64);
const NODE_DIGEST = 'b'.repeat(64);

function successfulInvoke() {
  return Promise.resolve({
    exitCode: 0,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: '{"written":true}\n',
    stderr: '',
  });
}

function candidate() {
  return Object.freeze({
    sourceSnapshot: Object.freeze({ digest: PACKAGE_DIGEST, files: Object.freeze([]) }),
    node: Object.freeze({ digest: NODE_DIGEST, size: 1 }),
    evidence: Object.freeze({ packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST }),
  });
}

function deps({
  elevated = true,
  exactService = false,
  probeReady = true,
  refreshResult = Object.freeze({ ready: true, changed: true, recovered: false, blocker: null }),
  refreshHealthReason = null,
  refreshHealthGeneration = 'candidate',
  refreshError = null,
  measureError = null,
} = {}) {
  const calls = [];
  const mechanics = Object.freeze({ fixture: true });
  return {
    calls,
    value: {
      inspectHost: async () => {
        calls.push('inspect-host');
        return { elevated, operatorSid: OPERATOR_SID, programData: 'C:\\ProgramData' };
      },
      measureCandidate: async () => {
        calls.push('measure-candidate');
        if (measureError) throw new Error(measureError);
        return candidate();
      },
      inspectServiceState: async (plan) => {
        calls.push('inspect-service');
        return exactService
          ? {
              exists: true,
              state: 'Running',
              startMode: 'Auto',
              startName: plan.service.account,
              pathName: plan.serviceCommand,
              description: plan.service.description,
            }
          : {
              exists: true,
              state: 'Running',
              startMode: 'Auto',
              startName: plan.service.account,
              pathName: 'C:\\stale\\authority.exe',
              description: 'stale generation',
            };
      },
      probe: async (plan) => {
        calls.push('probe');
        assert.deepEqual(plan.runtimeEvidence, { packageDigest: PACKAGE_DIGEST, nodeDigest: NODE_DIGEST });
        if (!probeReady) throw new Error('unavailable');
        return { protocol: 'devbridge/environment-operator-v1' };
      },
      createRefreshMechanics: (input) => {
        calls.push('create-refresh-mechanics');
        assert.equal(input.candidatePlan.runtime.generation.length, 64);
        assert.deepEqual(input.candidate.evidence, candidate().evidence);
        assert.equal(input.basePlan.runtimeEvidence, null);
        assert.equal(typeof input.probe, 'function');
        return mechanics;
      },
      refresh: async ({ candidateGeneration, mechanics: received, onDiagnostic }) => {
        calls.push('refresh');
        assert.equal(candidateGeneration.length, 64);
        assert.equal(received, mechanics);
        if (refreshHealthReason != null) {
          onDiagnostic({
            phase: 'refresh-health',
            state: 'completed',
            detail: {
              generation: refreshHealthGeneration === 'candidate' ? candidateGeneration : 'c'.repeat(64),
              ready: false,
              reason: refreshHealthReason,
            },
          });
        }
        if (refreshError) throw new Error(refreshError);
        return refreshResult;
      },
    },
  };
}

test('non-Windows setup leaves the Windows authority LEGO unattached', async () => {
  const fixture = deps();
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: '/tmp/state', platform: 'linux', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.protocol, WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROTOCOL);
  assert.equal(result.ready, true);
  assert.equal(result.service, 'not-applicable');
  assert.deepEqual(fixture.calls, []);
});

test('existing healthy exact protected authority requires exact SCM generation before trusting the read endpoint', async () => {
  const fixture = deps({ elevated: false, exactService: true, probeReady: true });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, true);
  assert.equal(result.changed, false);
  assert.equal(result.service, 'ready');
  assert.deepEqual(fixture.calls, ['inspect-host', 'measure-candidate', 'inspect-service', 'probe']);
});

test('ordinary setup never trusts a healthy stale-generation pipe and stops at elevation before refresh', async () => {
  const fixture = deps({ elevated: false, exactService: false, probeReady: true });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, false);
  assert.match(result.blocker, /elevated PowerShell/u);
  assert.deepEqual(fixture.calls, ['inspect-host', 'measure-candidate', 'inspect-service']);
});

test('candidate measurement failure is bounded and stops before service or authority probing', async () => {
  const fixture = deps({ elevated: false, measureError: 'C:\\sensitive\\candidate-path' });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, false);
  assert.match(result.blocker, /runtime candidate could not be verified/u);
  assert.doesNotMatch(result.blocker, /sensitive|candidate-path/iu);
  assert.deepEqual(fixture.calls, ['inspect-host', 'measure-candidate']);
});

test('elevated setup delegates the exact measured generation to the shared refresh transaction', async () => {
  const fixture = deps({ elevated: true, exactService: false });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.service, 'ready');
  assert.deepEqual(fixture.calls, ['inspect-host', 'measure-candidate', 'inspect-service', 'create-refresh-mechanics', 'refresh']);
});

test('candidate health rejection reports the shared exact rollback instead of stopping the recovered service', async () => {
  const fixture = deps({
    elevated: true,
    exactService: false,
    refreshResult: Object.freeze({ ready: false, changed: true, recovered: true, blocker: 'candidate-health' }),
  });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.equal(result.service, 'recovered-previous');
  assert.equal(result.protectedState, 'ready');
  assert.match(result.blocker, /previous generation was restored/u);
  assert.deepEqual(fixture.calls, ['inspect-host', 'measure-candidate', 'inspect-service', 'create-refresh-mechanics', 'refresh']);
});

test('Windows lifecycle authority health uses one bounded startup-readiness window', async () => {
  let attempts = 0;
  const delays = [];
  const result = await probeWindowsLifecycleAuthority({ stateDirectory: STATE }, {
    clientFactory: () => ({
      async inspect() {
        attempts += 1;
        if (attempts < 3) throw new Error('environment lifecycle authority is unavailable');
        return { protocol: 'devbridge/environment-operator-v1' };
      },
    }),
    activityClientFactory: () => ({ async inspect() { return { ready: true, identity: 'a'.repeat(32) }; } }),
    waitForRetry: async (delay) => { delays.push(delay); },
  });
  assert.equal(result.protocol, 'devbridge/environment-operator-v1');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 250]);
});

test('Windows lifecycle authority generation health separates endpoint readiness from workload readiness', async () => {
  const result = await probeWindowsLifecycleAuthority({ stateDirectory: STATE }, {
    clientFactory: () => ({ async inspect() { return { protocol: 'devbridge/environment-operator-v1' }; } }),
    activityClientFactory: () => ({ async inspect() { return { ready: false, identity: 'a'.repeat(32), reason: 'environment activity is unavailable' }; } }),
    waitForRetry: async () => { throw new Error('structural endpoint should be accepted immediately'); },
  });
  assert.equal(result.protocol, 'devbridge/environment-operator-v1');
});

test('Windows lifecycle authority health stops at its bounded readiness deadline', async () => {
  let attempts = 0;
  const delays = [];
  await assert.rejects(probeWindowsLifecycleAuthority({ stateDirectory: STATE }, {
    clientFactory: () => ({
      async inspect() {
        attempts += 1;
        throw new Error(`unavailable-${attempts}`);
      },
    }),
    activityClientFactory: () => ({ async inspect() { return { ready: true, identity: 'a'.repeat(32) }; } }),
    waitForRetry: async (delay) => { delays.push(delay); },
  }), /unavailable-6/u);
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [100, 250, 500, 1_000, 2_000]);
});

test('candidate health rejection preserves the exact bounded candidate failure reason', async () => {
  const fixture = deps({
    elevated: true,
    exactService: false,
    refreshResult: Object.freeze({ ready: false, changed: true, recovered: true, blocker: 'candidate-health' }),
    refreshHealthReason: 'Windows lifecycle authority structural protection proof failed: generations-directory:inheritance-enabled',
  });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.match(result.blocker, /previous generation was restored/u);
  assert.match(result.blocker, /Candidate health: Windows lifecycle authority structural protection proof failed: generations-directory:inheritance-enabled/u);
});

test('candidate health rejection does not misattribute another generation health reason', async () => {
  const fixture = deps({
    elevated: true,
    exactService: false,
    refreshResult: Object.freeze({ ready: false, changed: true, recovered: true, blocker: 'candidate-health' }),
    refreshHealthReason: 'unrelated recovery generation failed',
    refreshHealthGeneration: 'other',
  });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.match(result.blocker, /previous generation was restored/u);
  assert.doesNotMatch(result.blocker, /unrelated recovery generation/u);
});

test('shared refresh failure is bounded without leaking local platform detail', async () => {
  const fixture = deps({ elevated: true, exactService: false, refreshError: 'C:\\protected\\secret\\runtime' });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, false);
  assert.equal(result.service, 'blocked');
  assert.match(result.blocker, /reconciliation failed/u);
  assert.doesNotMatch(result.blocker, /secret|C:\\protected/iu);
  assert.deepEqual(fixture.calls, ['inspect-host', 'measure-candidate', 'inspect-service', 'create-refresh-mechanics', 'refresh']);
});

test('production elevated reconciliation no longer owns a monolithic provision or post-health stop path', async () => {
  const source = await readFile(SERVICE_SOURCE, 'utf8');
  assert.match(source, /reconcileWindowsLifecycleAuthorityRefresh/u);
  assert.match(source, /createWindowsLifecycleAuthorityRefreshMechanics/u);
  assert.doesNotMatch(source, /provisionWindowsLifecycleAuthority/u);
  assert.doesNotMatch(source, /stopped-after-failed-health/u);
});

test('authority migration copies only portable protected state and leaves image adoption and activity policy separate', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-migration-'));
  const state = path.join(temp, 'ordinary');
  const authority = path.join(temp, 'protected');
  try {
    await mkdir(path.join(state, 'environment-foundation', 'images'), { recursive: true });
    await mkdir(path.join(state, 'environment-lifecycle'), { recursive: true });
    await mkdir(path.join(state, 'environment-construction'), { recursive: true });
    await writeFile(path.join(state, 'environment-foundation', 'identity.json'), '{"identity":"protected"}\n');
    await writeFile(path.join(state, 'environment-foundation', 'images', 'catalog.json'), 'protected-image\n');
    await mkdir(path.join(state, 'environment-activity'), { recursive: true });
    await writeFile(path.join(state, 'environment-activity', 'policy.json'), 'ordinary-policy\n');
    await writeFile(path.join(state, 'environment-lifecycle', 'state.json'), 'protected-lifecycle\n');
    await writeFile(path.join(state, 'environment-construction', 'state.json'), 'protected-construction\n');

    const migrated = await migrateWindowsLifecycleAuthorityState({ stateDirectory: state, authorityDirectory: authority });
    assert.deepEqual(migrated.paths, WINDOWS_LIFECYCLE_AUTHORITY_STATE_PATHS);
    assert.equal(await readFile(path.join(authority, 'environment-foundation', 'identity.json'), 'utf8'), '{"identity":"protected"}\n');
    await assert.rejects(readFile(path.join(authority, 'environment-foundation', 'images', 'catalog.json'), 'utf8'), /ENOENT/u);
    assert.equal(await readFile(path.join(state, 'environment-foundation', 'images', 'catalog.json'), 'utf8'), 'protected-image\n');
    assert.equal(await readFile(path.join(authority, 'environment-lifecycle', 'state.json'), 'utf8'), 'protected-lifecycle\n');
    assert.equal(await readFile(path.join(authority, 'environment-construction', 'state.json'), 'utf8'), 'protected-construction\n');
    await assert.rejects(readFile(path.join(authority, 'environment-activity', 'policy.json'), 'utf8'), /ENOENT/u);
    assert.equal(await readFile(path.join(state, 'environment-activity', 'policy.json'), 'utf8'), 'ordinary-policy\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('closed migration refuses filesystem indirection instead of following authority outside its owner', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-migration-link-'));
  const state = path.join(temp, 'ordinary');
  const authority = path.join(temp, 'protected');
  const outside = path.join(temp, 'outside');
  try {
    await mkdir(path.join(state, 'environment-foundation'), { recursive: true });
    await mkdir(outside, { recursive: true });
    try {
      await import('node:fs/promises').then(({ symlink }) => symlink(outside, path.join(state, 'environment-foundation', 'control'), process.platform === 'win32' ? 'junction' : 'dir'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return t.skip('filesystem indirection creation is unavailable');
      throw error;
    }
    await assert.rejects(migrateWindowsLifecycleAuthorityState({ stateDirectory: state, authorityDirectory: authority }), /filesystem indirection/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
