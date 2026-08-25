import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWindowsLifecycleAuthorityPlan } from '../src/setup/windows-lifecycle-authority.js';
import {
  verifyWindowsLifecycleAuthorityService,
  WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROOF_PROTOCOL,
} from '../src/setup/windows-lifecycle-authority-service-proof.js';

const OPERATOR_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const PROGRAM_DATA = 'C:\\ProgramData';
const plan = createWindowsLifecycleAuthorityPlan({
  stateDirectory: STATE,
  programDataDirectory: PROGRAM_DATA,
  operatorSid: OPERATOR_SID,
});

function success(stdout = '{"ready":true}\n') {
  return Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' });
}

test('service proof requires the exact deterministic SCM command and virtual account', async () => {
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
  assert.match(input.command, /devbridge-lifecycle-authority-host\.exe" "--service-name" "DevBridgeLifecycle-/u);
  assert.match(input.command, /"--operator-sid" "S-1-5-21-111111111-222222222-333333333-1001"/u);
  assert.match(input.command, /"--mutation-pipe" "devbridge-environment-[0-9a-f]{32}-mutation-v1"$/u);
});

test('service proof rejects a service account that is not derived from the exact service name', async () => {
  const wrongName = Object.freeze({
    ...plan,
    service: Object.freeze({ ...plan.service, name: 'DevBridgeLifecycle-fedcba9876543210fedcba9876543210' }),
  });
  const wrongAccount = Object.freeze({
    ...plan,
    service: Object.freeze({ ...plan.service, account: 'NT SERVICE\\DevBridgeLifecycle-fedcba9876543210fedcba9876543210' }),
  });
  for (const candidate of [wrongName, wrongAccount]) {
    await assert.rejects(
      () => verifyWindowsLifecycleAuthorityService({ plan: candidate, operatorSid: OPERATOR_SID, invoke: async () => success() }),
      /service proof identity is invalid/u,
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
});
