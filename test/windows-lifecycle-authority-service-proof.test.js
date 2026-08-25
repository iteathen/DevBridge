import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  bindWindowsLifecycleAuthorityRuntime,
  createWindowsLifecycleAuthorityPlan,
} from '../src/setup/windows-lifecycle-authority.js';
import {
  verifyWindowsLifecycleAuthorityService,
  WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROOF_PROTOCOL,
} from '../src/setup/windows-lifecycle-authority-service-proof.js';

const OPERATOR_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const PROGRAM_DATA = 'C:\\ProgramData';
const basePlan = createWindowsLifecycleAuthorityPlan({
  stateDirectory: STATE,
  programDataDirectory: PROGRAM_DATA,
  operatorSid: OPERATOR_SID,
});
const plan = bindWindowsLifecycleAuthorityRuntime(basePlan, {
  packageDigest: 'a'.repeat(64),
  nodeDigest: 'b'.repeat(64),
});

function success(stdout = '{"ready":true}\n') {
  return Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' });
}

test('service proof requires exact SCM command, virtual account, and runtime description', async () => {
  let request = null;
  const result = await verifyWindowsLifecycleAuthorityService({
    plan,
    operatorSid: OPERATOR_SID,
    invoke: async (value) => { request = value; return success(); },
  });
  assert.equal(result.protocol, WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROOF_PROTOCOL);
  assert.equal(result.ready, true);
  assert.equal(request.executable, 'powershell.exe');
  const input = JSON.parse(request.input);
  assert.equal(input.name, plan.service.name);
  assert.equal(input.account, plan.service.account);
  assert.equal(input.command, plan.serviceCommand);
  assert.equal(input.description, plan.service.description);
  assert.match(input.command, /devbridge-lifecycle-authority-host\.exe" "--service-name" "DevBridgeLifecycle-/u);
  assert.match(input.command, /"--operator-sid" "S-1-5-21-111111111-222222222-333333333-1001"/u);
  assert.match(input.command, /"--mutation-pipe" "devbridge-environment-[0-9a-f]{32}-mutation-v1"$/u);
  assert.match(input.description, /package=a{64} node=b{64}$/u);
});

test('service proof rejects an unbound plan or mismatched service identity/runtime evidence', async () => {
  const wrongName = Object.freeze({
    ...plan,
    service: Object.freeze({ ...plan.service, name: 'DevBridgeLifecycle-fedcba9876543210fedcba9876543210' }),
  });
  const wrongAccount = Object.freeze({
    ...plan,
    service: Object.freeze({ ...plan.service, account: 'NT SERVICE\\DevBridgeLifecycle-fedcba9876543210fedcba9876543210' }),
  });
  const wrongRuntimeEvidence = Object.freeze({
    ...plan,
    service: Object.freeze({ ...plan.service, description: 'DevBridge lifecycle authority runtime v1' }),
  });

  await assert.rejects(
    () => verifyWindowsLifecycleAuthorityService({ plan: basePlan, operatorSid: OPERATOR_SID, invoke: async () => success() }),
    /service proof plan is incomplete/u,
  );
  for (const candidate of [wrongRuntimeEvidence, wrongName, wrongAccount]) {
    await assert.rejects(
      () => verifyWindowsLifecycleAuthorityService({ plan: candidate, operatorSid: OPERATOR_SID, invoke: async () => success() }),
      /service proof (?:runtime evidence|identity) is invalid/u,
    );
  }
});

test('service proof fails closed on missing, mismatched, or malformed SCM evidence', async () => {
  for (const stdout of ['{"ready":false}\n', '{}\n', '{"ready":true,"detail":"leak"}\n', 'not-json\n']) {
    await assert.rejects(
      () => verifyWindowsLifecycleAuthorityService({ plan, operatorSid: OPERATOR_SID, invoke: async () => success(stdout) }),
      /did not verify the exact protected service/u,
    );
  }
});

test('hosted Windows PowerShell parses the read-only SCM proof without creating a service', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows PowerShell qualification runs on Windows CI');
  await assert.rejects(
    () => verifyWindowsLifecycleAuthorityService({ plan, operatorSid: OPERATOR_SID }),
    /did not verify the exact protected service/u,
  );
});

test('service proof diagnostics do not propagate raw SCM path or account evidence', async () => {
  await assert.rejects(
    () => verifyWindowsLifecycleAuthorityService({
      plan,
      operatorSid: OPERATOR_SID,
      invoke: async () => ({
        exitCode: 1,
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        stdout: '',
        stderr: 'C:\\sensitive\\host.exe NT SERVICE\\sensitive',
      }),
    }),
    (error) => {
      assert.match(error.message, /service identity proof failed/u);
      assert.doesNotMatch(error.message, /sensitive|host\.exe/iu);
      return true;
    },
  );
});

test('service proof implementation is observation-only', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-service-proof.js', import.meta.url)), 'utf8');
  for (const forbidden of [
    'sc.exe',
    'Start-Service',
    'Stop-Service',
    'New-Service',
    'Set-Service',
    'Set-Acl',
    'Add-LocalGroupMember',
    'Remove-LocalGroupMember',
    'Remove-Item',
  ]) assert.equal(source.includes(forbidden), false, `service proof gained mutation authority through ${forbidden}`);
  assert.equal(source.includes('Get-CimInstance Win32_Service'), true);
  assert.equal(source.includes('$service.Description'), true);
});
