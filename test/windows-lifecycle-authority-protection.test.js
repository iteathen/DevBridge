import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  verifyWindowsLifecycleAuthorityProtection,
  WINDOWS_LIFECYCLE_AUTHORITY_PROTECTION_PROTOCOL,
} from '../src/setup/windows-lifecycle-authority-protection.js';

const SOURCE = fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-protection.js', import.meta.url));

function plan() {
  return {
    protectedRoot: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef',
    authorityDirectory: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\state',
    ownershipManifest: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\ownership.json',
    service: {
      account: 'NT SERVICE\\DevBridgeLifecycle-0123456789abcdef0123456789abcdef',
      hyperVGroupSid: 'S-1-5-32-578',
    },
    runtime: {
      generationsDirectory: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\generations',
      generationDirectory: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\generations\\' + 'a'.repeat(64),
      binDirectory: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\bin',
      runtimeDirectory: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\runtime',
      packageDirectory: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\runtime\\package',
      nodeExecutable: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\bin\\node.exe',
      serviceHostExecutable: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\bin\\host.exe',
      workerEntry: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\0123456789abcdef0123456789abcdef\\runtime\\package\\src\\entry\\worker.mjs',
    },
    endpoints: {
      mutation: { endpoint: '\\\\.\\pipe\\devbridge-environment-0123456789abcdef0123456789abcdef-mutation-v1' },
    },
  };
}

test('elevated protection proof consumes only the setup-owned plan and returns bounded evidence', async () => {
  let observedPlan = null;
  let observedInvoke = null;
  const invoke = async () => { throw new Error('structural proof owns invocation'); };
  const result = await verifyWindowsLifecycleAuthorityProtection({ plan: plan(), elevated: true, invoke, environment: { TEST: '1' } }, {
    structuralProof: async (selected, selectedInvoke, environment) => {
      observedPlan = selected;
      observedInvoke = selectedInvoke;
      assert.deepEqual(environment, { TEST: '1' });
    },
  });
  assert.equal(result.protocol, WINDOWS_LIFECYCLE_AUTHORITY_PROTECTION_PROTOCOL);
  assert.deepEqual(result, { protocol: WINDOWS_LIFECYCLE_AUTHORITY_PROTECTION_PROTOCOL, ready: true, mode: 'structural' });
  assert.equal(observedPlan.service.account, plan().service.account);
  assert.equal(observedInvoke, invoke);
});

test('ordinary protection proof requires both filesystem write denial and mutation endpoint denial', async () => {
  const calls = [];
  const selected = plan();
  const result = await verifyWindowsLifecycleAuthorityProtection({ plan: selected, elevated: false, invoke: async () => { throw new Error('PowerShell must not run'); } }, {
    ownershipWriteDenied: async (target) => { calls.push(['state', target]); },
    mutationConnectionDenied: async (endpoint) => { calls.push(['mutation', endpoint]); },
  });
  assert.deepEqual(result, { protocol: WINDOWS_LIFECYCLE_AUTHORITY_PROTECTION_PROTOCOL, ready: true, mode: 'ordinary-negative' });
  assert.deepEqual(calls, [
    ['state', selected.ownershipManifest],
    ['mutation', selected.endpoints.mutation.endpoint],
  ]);
});

test('ordinary protection proof fails closed when either negative capability proof fails', async () => {
  await assert.rejects(
    verifyWindowsLifecycleAuthorityProtection({ plan: plan(), elevated: false }, {
      ownershipWriteDenied: async () => { throw new Error('writable'); },
      mutationConnectionDenied: async () => { throw new Error('must not run'); },
    }),
    /writable/u,
  );
  await assert.rejects(
    verifyWindowsLifecycleAuthorityProtection({ plan: plan(), elevated: false }, {
      ownershipWriteDenied: async () => {},
      mutationConnectionDenied: async () => { throw new Error('connectable'); },
    }),
    /connectable/u,
  );
});

test('structural proof is read-only and checks exact protected ACL and Hyper-V service membership', async () => {
  let encoded = null;
  let input = null;
  const selected = plan();
  const result = await verifyWindowsLifecycleAuthorityProtection({
    plan: selected,
    elevated: true,
    invoke: async (request) => {
      encoded = request.arguments.at(-1);
      input = JSON.parse(request.input);
      return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"ready":true}\n', stderr: '' };
    },
  });
  assert.equal(result.ready, true);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  for (const required of [
    'AreAccessRulesProtected',
    'GetAccessRules($true, $true',
    "'read' $false 'generations-directory'",
    'Get-LocalGroupMember',
    'ReadAndExecute',
    'Modify',
    'DeleteSubdirectoriesAndFiles',
    'ChangePermissions',
    'TakeOwnership',
  ]) assert.equal(script.includes(required), true, `protection proof lost ${required}`);
  assert.deepEqual(input, {
    protectedRoot: selected.protectedRoot,
    authorityDirectory: selected.authorityDirectory,
    generationsDirectory: selected.runtime.generationsDirectory,
    generationDirectory: selected.runtime.generationDirectory,
    binDirectory: selected.runtime.binDirectory,
    runtimeDirectory: selected.runtime.runtimeDirectory,
    packageDirectory: selected.runtime.packageDirectory,
    nodeExecutable: selected.runtime.nodeExecutable,
    serviceHostExecutable: selected.runtime.serviceHostExecutable,
    workerEntry: selected.runtime.workerEntry,
    serviceAccount: selected.service.account,
    hyperVGroupSid: selected.service.hyperVGroupSid,
  });
});

test('structural proof failure exposes no raw ACL or path diagnostic', async () => {
  await assert.rejects(
    verifyWindowsLifecycleAuthorityProtection({
      plan: plan(),
      elevated: true,
      invoke: async () => ({ exitCode: 1, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: 'C:\\sensitive\\path ACL S-1-secret' }),
    }),
    (error) => {
      assert.match(error.message, /structural protection proof failed/u);
      assert.doesNotMatch(error.message, /sensitive|S-1-secret/u);
      return true;
    },
  );
});

test('protection verifier contains no mutation or service-management implementation', async () => {
  const source = await readFile(SOURCE, 'utf8');
  for (const forbidden of [
    'Set-Acl',
    'Add-LocalGroupMember',
    'Remove-LocalGroupMember',
    'Start-Service',
    'Stop-Service',
    'sc.exe',
    'Remove-Item',
    'New-Item',
  ]) assert.equal(source.includes(forbidden), false, `protection verifier leaked ${forbidden}`);
  assert.equal(source.includes("open(ownershipManifest, 'r+')"), true);
  assert.equal(source.includes('createConnection(endpoint)'), true);
});
