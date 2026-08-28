import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deterministicOperationSecurity } from '../src/runtime/deterministic-operation-security.js';
import { createSetupStatusOperation, projectSetupStatus } from '../src/setup/status-operation.js';

function blockedResult() {
  return {
    protocol: 'devbridge/setup-status-v1',
    home: 'C:\\Users\\operator\\.devbridge',
    phase: 'blocked',
    blocked: true,
    blocker: 'accepted repositories are unavailable: owner/private-repo; local state C:\\Users\\operator\\.devbridge\\state',
    readyForConstruction: false,
    path: {
      persisted: true,
      changed: false,
      requiresNewShell: true,
      command: 'C:\\Users\\operator\\.devbridge\\bin\\devbridge.cmd',
      binDirectory: 'C:\\Users\\operator\\.devbridge\\bin',
      temporaryCommand: 'node C:\\Users\\operator\\.devbridge\\bin\\devbridge.js',
    },
    github: { id: 42, login: 'operator' },
    repositories: {
      discoveredCount: 33,
      eligibleCount: 31,
      selectedCount: 0,
      needsSelection: true,
      reason: 'use --repository owner/private-repo',
      selected: [{ id: 1, fullName: 'owner/private-repo', private: true }],
      excluded: [
        { id: 2, fullName: 'owner/old', reason: 'archived' },
        { id: 3, fullName: 'owner/readonly', reason: 'read-only' },
      ],
    },
    prerequisites: {
      protocol: 'devbridge/setup-prerequisites-v1',
      platform: 'win32',
      ready: false,
      blocker: 'repair data at /home/operator/private/setup; then retry owner/private-repo',
      changed: true,
      restartRequired: false,
      capabilities: { gpgv: true, opensshClient: false },
    },
    operational: { ready: false, changed: false, executionEnabled: false },
    linuxProfile: {
      profile: 'linux-development',
      snapshot: '20260821T200000Z',
      physicalStatus: {
        subject: 'local-subject-identity',
        state: 'blocked',
        phase: null,
        complete: false,
        blocked: true,
        reason: 'required host tool is unavailable: gpgv.exe',
        image: 'C:\\Users\\operator\\private\\image.vhdx',
        authorityRegistered: false,
        preflight: {
          ready: false,
          reason: 'required host tool is unavailable: gpgv.exe',
          platform: 'win32',
          capabilities: { provider: true, connectivity: true, keyring: true, memory: true, storage: true },
          connectivity: { control: 'system', addressing: 'automatic' },
          resources: { storage: { directory: 'C:\\Users\\operator\\private' } },
        },
      },
    },
    windowsProfile: {
      profile: 'windows-development',
      media: {
        state: 'accepted',
        inbox: 'C:\\Users\\operator\\private\\media',
        candidates: [{ subject: 'candidate-secret', source: 'source-secret' }],
        rejectedCount: 1,
        accepted: {
          candidate: 'candidate-secret',
          authority: 'C:\\Users\\operator\\private\\authority.json',
          sourceClass: 'official-owned',
          temporary: false,
          media: { name: 'private.iso', bytes: 100, sha256: 'a'.repeat(64) },
          image: { index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', build: 26100 },
        },
      },
      construction: {
        state: 'blocked',
        reason: 'provider data at C:\\Users\\operator\\private\\provider-state is unavailable',
        physical: {
          state: 'blocked',
          phase: 'absent',
          complete: false,
          blocked: true,
          reason: 'source C:\\Users\\operator\\private\\media.iso is unavailable',
          subject: 'subject-private',
          image: 'C:\\Users\\operator\\private\\windows.vhdx',
          authorityRegistered: false,
          preflight: {
            ready: false,
            reason: 'storage C:\\Users\\operator\\private\\images is unavailable',
            platform: 'win32',
            capabilities: { provider: true, connectivity: true, keyring: false, memory: true, storage: false },
          },
        },
      },
    },
  };
}

test('setup.status is host control and never repository execution', () => {
  assert.deepEqual(deterministicOperationSecurity('setup.status'), {
    executionClass: 'control-process',
    repositoryCode: false,
    repositoryExecutionRequired: false,
    executionRequirement: 'host-control',
  });
});

test('setup.status exposes a parameter-free observation contract with no run surface', () => {
  const operation = createSetupStatusOperation({ runSetup: async () => blockedResult() });
  assert.deepEqual(operation.validate({}), {});
  assert.throws(() => operation.validate({ command: 'anything' }), /accepts no parameters/u);
  assert.throws(() => operation.validate({ repository: 'owner/private-repo' }), /accepts no parameters/u);
  assert.deepEqual(operation.publicSchema, { type: 'object', additionalProperties: false, properties: {} });
  assert.equal(Object.hasOwn(operation, 'run'), false);
});

test('setup.status delegates with no remote arguments and returns blocked setup as observed data', async () => {
  let received = null;
  const operation = createSetupStatusOperation({
    runSetup: async (...args) => {
      received = args;
      return blockedResult();
    },
  });

  const observed = await operation.execute(operation.validate({}));
  assert.deepEqual(received, []);
  assert.equal(observed.exitCode, 0);
  assert.equal(observed.stderr, '');
  const projected = JSON.parse(observed.stdout);
  assert.equal(projected.blocked, true);
  assert.equal(projected.readyForConstruction, false);
  assert.equal(projected.prerequisites.ready, false);
  assert.equal(projected.prerequisites.capabilities.opensshClient, false);
  assert.deepEqual(projected.operational, { ready: false, executionEnabled: false });
  assert.equal(projected.linuxProfile.physicalStatus.preflight.capabilities.provider, true);
  assert.equal(projected.linuxProfile.physicalStatus.preflight.capabilities.connectivity, true);
  assert.deepEqual(projected.linuxProfile.physicalStatus.preflight.connectivity, { control: 'system', addressing: 'automatic' });
  assert.deepEqual(projected.windowsProfile, {
    profile: 'windows-development',
    media: {
      state: 'accepted',
      blocker: null,
      candidateCount: 1,
      rejectedCount: 1,
      accepted: {
        sourceClass: 'official-owned',
        temporary: false,
        image: { index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', build: 26100 },
      },
    },
    construction: {
      state: 'blocked',
      reason: 'provider data at <local-path>',
      physicalStatus: {
        state: 'blocked',
        phase: 'absent',
        complete: false,
        blocked: true,
        reason: 'source <local-path>',
        authorityRegistered: false,
        preflight: {
          ready: false,
          reason: 'storage <local-path>',
          platform: 'win32',
          capabilities: { provider: true, connectivity: true, keyring: false, memory: true, storage: false },
          connectivity: null,
        },
      },
    },
  });
});

test('setup status projection removes local paths and repository or identity details', () => {
  const projected = projectSetupStatus(blockedResult());
  const serialized = JSON.stringify(projected);

  assert.match(projected.blocker, /<repository>/u);
  assert.match(projected.blocker, /<local-path>/u);
  assert.match(projected.prerequisites.blocker, /<local-path>/u);
  assert.match(projected.prerequisites.blocker, /<repository>/u);
  assert.deepEqual(projected.repositories.excludedCounts, { archived: 1, 'read-only': 1 });

  for (const forbidden of [
    'C:\\Users\\operator',
    '/home/operator',
    'owner/private-repo',
    'owner/old',
    'owner/readonly',
    'local-subject-identity',
    'github',
    'fullName',
    'binDirectory',
    'temporaryCommand',
    'image.vhdx',
    'candidate-secret',
    'source-secret',
    'private.iso',
    'authority.json',
    'subject-private',
    'windows.vhdx',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('runtime composition registers setup.status only through runDevBridgeSetup', async () => {
  const source = await readFile(new URL('../src/app/runtime.js', import.meta.url), 'utf8');
  assert.match(source, /operationRegistry\.register\('setup\.status', createSetupStatusOperation/u);
  assert.match(source, /runSetup: \(\) => runDevBridgeSetup\(\{ env \}, \{ fetchImpl \}\)/u);
  assert.doesNotMatch(source, /setup\.status[^\n]*\.run\(/u);
});
