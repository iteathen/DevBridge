import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSetupPrerequisites } from '../src/setup/prerequisite-reconciliation.js';

function success(value = '') {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  };
}

function decodedPowerShell(request) {
  return Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
}

test('missing gpgv is a focused blocker before any later prerequisite mutation', async () => {
  const calls = [];
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
      calls.push(request);
      if (request.executable === 'gpgv.exe') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      throw new Error('PowerShell must not run after the first caller-required boundary');
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.changed, false);
  assert.match(result.blocker, /gpgv\.exe is not usable/u);
  assert.deepEqual(calls.map((request) => request.executable), ['gpgv.exe']);
});

test('non-elevated Windows OpenSSH gap stops at an explicit elevation boundary', async () => {
  const scripts = [];
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
      if (request.executable === 'gpgv.exe') return success('gpgv ready');
      assert.equal(request.executable, 'powershell.exe');
      const script = decodedPowerShell(request);
      scripts.push(script);
      assert.doesNotMatch(script, /Add-WindowsCapability/u);
      return success({ elevated: false, ssh: false, sshKeygen: false, capabilityState: null });
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.changed, false);
  assert.equal(result.restartRequired, false);
  assert.match(result.blocker, /elevated PowerShell/u);
  assert.equal(scripts.length, 1);
});

test('elevated Windows setup establishes only the missing OpenSSH Client capability and verifies it', async () => {
  let installed = false;
  let establishmentCalls = 0;
  let inspectionCalls = 0;
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
      if (request.executable === 'gpgv.exe') return success('gpgv ready');
      assert.equal(request.executable, 'powershell.exe');
      const script = decodedPowerShell(request);
      if (/Add-WindowsCapability/u.test(script)) {
        establishmentCalls += 1;
        assert.match(script, /OpenSSH\.Client~~~~0\.0\.1\.0/u);
        installed = true;
        return success({ restartNeeded: false });
      }
      inspectionCalls += 1;
      return success(installed
        ? { elevated: true, ssh: true, sshKeygen: true, capabilityState: null }
        : { elevated: true, ssh: false, sshKeygen: false, capabilityState: 'NotPresent' });
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.restartRequired, false);
  assert.deepEqual(result.capabilities, { gpgv: true, opensshClient: true });
  assert.equal(establishmentCalls, 1);
  assert.equal(inspectionCalls, 2);
});

test('OpenSSH establishment requiring restart returns a resumable restart boundary without pretending readiness', async () => {
  let establishmentCalls = 0;
  let inspectionCalls = 0;
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
      if (request.executable === 'gpgv.exe') return success('gpgv ready');
      const script = decodedPowerShell(request);
      if (/Add-WindowsCapability/u.test(script)) {
        establishmentCalls += 1;
        return success({ restartNeeded: true });
      }
      inspectionCalls += 1;
      return success({ elevated: true, ssh: false, sshKeygen: false, capabilityState: 'NotPresent' });
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.equal(result.restartRequired, true);
  assert.match(result.blocker, /requires a restart/u);
  assert.equal(establishmentCalls, 1);
  assert.equal(inspectionCalls, 1);
});

test('re-entry after OpenSSH establishment converges without repeating the mutation', async () => {
  let installed = false;
  let establishmentCalls = 0;
  const invoke = async (request) => {
    if (request.executable === 'gpgv.exe') return success('gpgv ready');
    const script = decodedPowerShell(request);
    if (/Add-WindowsCapability/u.test(script)) {
      establishmentCalls += 1;
      installed = true;
      return success({ restartNeeded: false });
    }
    return success(installed
      ? { elevated: true, ssh: true, sshKeygen: true, capabilityState: null }
      : { elevated: true, ssh: false, sshKeygen: false, capabilityState: 'NotPresent' });
  };

  const first = await reconcileSetupPrerequisites({ platform: 'win32', environment: {}, invoke });
  const resumed = await reconcileSetupPrerequisites({ platform: 'win32', environment: {}, invoke });

  assert.equal(first.ready, true);
  assert.equal(first.changed, true);
  assert.equal(resumed.ready, true);
  assert.equal(resumed.changed, false);
  assert.equal(establishmentCalls, 1);
});

test('non-Windows setup verifies gpgv usability without Windows servicing', async () => {
  const calls = [];
  const result = await reconcileSetupPrerequisites({
    platform: 'linux',
    environment: {},
    async invoke(request) {
      calls.push(request);
      assert.equal(request.executable, 'gpgv');
      return success('gpgv ready');
    },
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.capabilities, { gpgv: true, opensshClient: 'not-applicable' });
  assert.deepEqual(calls.map((request) => request.executable), ['gpgv']);
});
