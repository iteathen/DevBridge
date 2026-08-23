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

const SIGNATURE_VERIFIER = 'C:\\Program Files\\GnuPG\\bin\\gpgv.exe';

function signatureDependency(overrides = {}) {
  return {
    async windowsSignatureVerifier() {
      return {
        ready: true,
        changed: false,
        blocker: null,
        executable: SIGNATURE_VERIFIER,
        ...overrides,
      };
    },
  };
}

test('Windows signature-verification blocker stops before any later prerequisite mutation', async () => {
  const calls = [];
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
      calls.push(request);
      throw new Error('OpenSSH inspection must not run after the first prerequisite boundary');
    },
  }, signatureDependency({ ready: false, blocker: 'signature verification needs elevation', executable: null }));

  assert.equal(result.ready, false);
  assert.equal(result.changed, false);
  assert.match(result.blocker, /signature verification needs elevation/u);
  assert.deepEqual(result.capabilities, { gpgv: false, opensshClient: null });
  assert.equal(calls.length, 0);
});

test('non-elevated Windows OpenSSH gap stops at an explicit elevation boundary and preserves the verifier binding', async () => {
  const scripts = [];
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
      assert.equal(request.executable, 'powershell.exe');
      const script = decodedPowerShell(request);
      scripts.push(script);
      assert.doesNotMatch(script, /Add-WindowsCapability/u);
      return success({ elevated: false, ssh: false, sshKeygen: false, capabilityState: null });
    },
  }, signatureDependency());

  assert.equal(result.ready, false);
  assert.equal(result.changed, false);
  assert.equal(result.restartRequired, false);
  assert.match(result.blocker, /elevated PowerShell/u);
  assert.equal(result.local.signatureVerifierExecutable, SIGNATURE_VERIFIER);
  assert.equal(scripts.length, 1);
});

test('a signature-verifier installation remains reported as a change when a later prerequisite blocks', async () => {
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
      assert.equal(request.executable, 'powershell.exe');
      return success({ elevated: false, ssh: false, sshKeygen: false, capabilityState: null });
    },
  }, signatureDependency({ changed: true }));

  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.equal(result.local.signatureVerifierExecutable, SIGNATURE_VERIFIER);
});

test('elevated Windows setup establishes only the missing OpenSSH Client capability and verifies it', async () => {
  let installed = false;
  let establishmentCalls = 0;
  let inspectionCalls = 0;
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: {},
    async invoke(request) {
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
  }, signatureDependency());

  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.restartRequired, false);
  assert.deepEqual(result.capabilities, { gpgv: true, opensshClient: true });
  assert.equal(result.local.signatureVerifierExecutable, SIGNATURE_VERIFIER);
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
      const script = decodedPowerShell(request);
      if (/Add-WindowsCapability/u.test(script)) {
        establishmentCalls += 1;
        return success({ restartNeeded: true });
      }
      inspectionCalls += 1;
      return success({ elevated: true, ssh: false, sshKeygen: false, capabilityState: 'NotPresent' });
    },
  }, signatureDependency());

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

  const first = await reconcileSetupPrerequisites({ platform: 'win32', environment: {}, invoke }, signatureDependency());
  const resumed = await reconcileSetupPrerequisites({ platform: 'win32', environment: {}, invoke }, signatureDependency());

  assert.equal(first.ready, true);
  assert.equal(first.changed, true);
  assert.equal(resumed.ready, true);
  assert.equal(resumed.changed, false);
  assert.equal(establishmentCalls, 1);
});

test('Windows prerequisite reconciliation forwards the local fetch contract only to the signature-verifier adapter', async () => {
  const fetchImpl = async () => { throw new Error('not invoked by this injected adapter'); };
  let observed = null;
  const result = await reconcileSetupPrerequisites({
    platform: 'win32',
    environment: { TEST: 'value' },
    fetchImpl,
    async invoke(request) {
      return success({ elevated: true, ssh: true, sshKeygen: true, capabilityState: null });
    },
  }, {
    async windowsSignatureVerifier(request) {
      observed = request;
      return { ready: true, changed: false, blocker: null, executable: SIGNATURE_VERIFIER };
    },
  });

  assert.equal(result.ready, true);
  assert.equal(observed.fetchImpl, fetchImpl);
  assert.deepEqual(observed.environment, { TEST: 'value' });
  assert.equal(typeof observed.invoke, 'function');
});

test('non-Windows setup verifies gpgv usability without Windows servicing and binds it locally', async () => {
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
  assert.equal(result.local.signatureVerifierExecutable, 'gpgv');
  assert.deepEqual(calls.map((request) => request.executable), ['gpgv']);
});
