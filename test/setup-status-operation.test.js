import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deterministicOperationSecurity } from '../src/runtime/deterministic-operation-security.js';
import { createSetupStatusOperation, projectSetupStatus } from '../src/setup/status-operation.js';

function blockedResult() {
  return {
    protocol: 'devbridge/setup-status-v1',
    phase: 'blocked',
    blocked: true,
    blocker: 'existing unrelated devbridge command blocks PATH installation: C:\\foreign\\devbridge.cmd',
    readyForConstruction: false,
    path: { persisted: true, changed: false, requiresNewShell: true, command: 'C:\\private\\devbridge.cmd' },
    repositories: {
      discoveredCount: 33,
      eligibleCount: 31,
      selectedCount: 0,
      needsSelection: true,
      excluded: [{ fullName: 'owner/old', reason: 'archived' }, { fullName: 'owner/readonly', reason: 'read-only' }],
    },
    linuxProfile: {
      profile: 'linux-development',
      snapshot: '20260821T200000Z',
      physicalStatus: {
        state: 'blocked',
        phase: null,
        complete: false,
        blocked: true,
        reason: 'required host tool is unavailable: gpgv.exe',
        authorityRegistered: false,
        preflight: {
          ready: false,
          reason: 'required host tool is unavailable: gpgv.exe',
          platform: 'win32',
          capabilities: { provider: true, keyring: true, memory: true, storage: true },
        },
      },
    },
  };
}

test('setup.status is a host-control observation and never repository execution', () => {
  assert.deepEqual(deterministicOperationSecurity('setup.status'), {
    executionClass: 'control-process',
    repositoryCode: false,
    repositoryExecutionRequired: false,
    executionRequirement: 'host-control',
  });
});

test('setup.status accepts no remote authority parameters', () => {
  const operation = createSetupStatusOperation({ runSetup: async () => blockedResult() });
  assert.deepEqual(operation.validate({}), {});
  assert.throws(() => operation.validate({ command: 'anything' }), /accepts no parameters/u);
  assert.throws(() => operation.validate({ repository: 'owner/repo' }), /accepts no parameters/u);
});

test('setup.status publishes blocker evidence as data while removing local paths', async () => {
  const operation = createSetupStatusOperation({ runSetup: async () => blockedResult() });
  const result = await operation.execute({});
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const projected = JSON.parse(result.stdout);
  assert.equal(projected.blocked, true);
  assert.equal(projected.readyForConstruction, false);
  assert.match(projected.blocker, /<local-path>/u);
  assert.doesNotMatch(result.stdout, /foreign|private|devbridge\.cmd/u);
  assert.deepEqual(projected.repositories.excludedCounts, { archived: 1, 'read-only': 1 });
  assert.equal(projected.linuxProfile.physicalStatus.preflight.capabilities.provider, true);
});

test('setup status projection contains no home, command, bin directory, identity, or repository names', () => {
  const projected = projectSetupStatus(blockedResult());
  const serialized = JSON.stringify(projected);
  for (const forbidden of ['home', 'command', 'binDirectory', 'temporaryCommand', 'fullName', 'owner/old', 'owner/readonly']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('runtime composition wires setup.status only to the setup app, never physical run', async () => {
  const source = await readFile(new URL('../src/app/runtime.js', import.meta.url), 'utf8');
  assert.match(source, /register\('setup\.status', createSetupStatusOperation/u);
  assert.match(source, /runDevBridgeSetup\(\{ env \}, \{ fetchImpl \}\)/u);
  assert.doesNotMatch(source, /ubuntuProductionImagePhysicalCanary[^\n]*run/u);
});
