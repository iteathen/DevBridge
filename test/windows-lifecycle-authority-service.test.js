import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  migrateWindowsLifecycleAuthorityState,
  reconcileWindowsLifecycleAuthorityService,
  WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROTOCOL,
  WINDOWS_LIFECYCLE_AUTHORITY_STATE_PATHS,
} from '../src/setup/windows-lifecycle-authority-service.js';

const OPERATOR_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const STATE = 'C:\\Users\\Operator\\.devbridge\\state';

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

function deps({ elevated = true, firstProbe = false, finalProbe = true, provisionError = null } = {}) {
  const calls = [];
  let probes = 0;
  return {
    calls,
    value: {
      inspectHost: async () => {
        calls.push('inspect-host');
        return { elevated, operatorSid: OPERATOR_SID, programData: 'C:\\ProgramData' };
      },
      probe: async () => {
        probes += 1;
        calls.push(`probe-${probes}`);
        if ((probes === 1 && !firstProbe) || (probes > 1 && !finalProbe)) throw new Error('unavailable');
        return { protocol: 'devbridge/environment-operator-v1' };
      },
      provision: async ({ plan }) => {
        calls.push('provision');
        if (provisionError) throw new Error(provisionError);
        return {
          changed: true,
          ownership: {
            protocol: 'devbridge/windows-lifecycle-authority-ownership-v1',
            authorityIdentity: plan.authorityIdentity,
            serviceName: plan.service.name,
            operatorSid: OPERATOR_SID,
            stateMigrationComplete: true,
            runtime: null,
            serviceConfigured: true,
            serviceReady: false,
          },
        };
      },
      stop: async () => { calls.push('stop'); },
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

test('existing healthy protected authority is observation-only and requires no elevation or mutation', async () => {
  const fixture = deps({ elevated: false, firstProbe: true });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, true);
  assert.equal(result.changed, false);
  assert.equal(result.service, 'ready');
  assert.deepEqual(fixture.calls, ['inspect-host', 'probe-1']);
});

test('missing protected authority stops at an explicit elevation boundary before provisioning', async () => {
  const fixture = deps({ elevated: false });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, false);
  assert.match(result.blocker, /elevated PowerShell/u);
  assert.deepEqual(fixture.calls, ['inspect-host', 'probe-1']);
});

test('elevated setup provisions one protected owner then requires exact post-start health', async () => {
  const fixture = deps({ elevated: true });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.service, 'ready');
  assert.deepEqual(fixture.calls, ['inspect-host', 'probe-1', 'provision', 'probe-2']);
});

test('failed post-start health stops the service rather than leaving partial authority active', async () => {
  const fixture = deps({ elevated: true, finalProbe: false });
  const result = await reconcileWindowsLifecycleAuthorityService({ stateDirectory: STATE, platform: 'win32', invoke: successfulInvoke }, fixture.value);
  assert.equal(result.ready, false);
  assert.equal(result.service, 'stopped-after-failed-health');
  assert.match(result.blocker, /post-start health proof/u);
  assert.deepEqual(fixture.calls, ['inspect-host', 'probe-1', 'provision', 'probe-2', 'stop']);
});

test('authority migration copies only closed protected state and leaves execution routes ordinary', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-migration-'));
  const state = path.join(temp, 'ordinary');
  const authority = path.join(temp, 'protected');
  try {
    await mkdir(path.join(state, 'environment-foundation', 'images'), { recursive: true });
    await mkdir(path.join(state, 'environment-lifecycle'), { recursive: true });
    await mkdir(path.join(state, 'environment-construction'), { recursive: true });
    await writeFile(path.join(state, 'environment-foundation', 'identity.json'), '{"identity":"protected"}\n');
    await writeFile(path.join(state, 'environment-foundation', 'images', 'catalog.json'), 'protected-image\n');
    await writeFile(path.join(state, 'environment-foundation', 'execution-routes.json'), 'ordinary-route\n');
    await writeFile(path.join(state, 'environment-lifecycle', 'state.json'), 'protected-lifecycle\n');
    await writeFile(path.join(state, 'environment-construction', 'state.json'), 'protected-construction\n');

    const migrated = await migrateWindowsLifecycleAuthorityState({ stateDirectory: state, authorityDirectory: authority });
    assert.deepEqual(migrated.paths, WINDOWS_LIFECYCLE_AUTHORITY_STATE_PATHS);
    assert.equal(await readFile(path.join(authority, 'environment-foundation', 'identity.json'), 'utf8'), '{"identity":"protected"}\n');
    assert.equal(await readFile(path.join(authority, 'environment-foundation', 'images', 'catalog.json'), 'utf8'), 'protected-image\n');
    assert.equal(await readFile(path.join(authority, 'environment-lifecycle', 'state.json'), 'utf8'), 'protected-lifecycle\n');
    assert.equal(await readFile(path.join(authority, 'environment-construction', 'state.json'), 'utf8'), 'protected-construction\n');
    await assert.rejects(readFile(path.join(authority, 'environment-foundation', 'execution-routes.json'), 'utf8'), /ENOENT/u);
    assert.equal(await readFile(path.join(state, 'environment-foundation', 'execution-routes.json'), 'utf8'), 'ordinary-route\n');
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
      await import('node:fs/promises').then(({ symlink }) => symlink(outside, path.join(state, 'environment-foundation', 'images'), process.platform === 'win32' ? 'junction' : 'dir'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return t.skip('filesystem indirection creation is unavailable');
      throw error;
    }
    await assert.rejects(migrateWindowsLifecycleAuthorityState({ stateDirectory: state, authorityDirectory: authority }), /filesystem indirection/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
