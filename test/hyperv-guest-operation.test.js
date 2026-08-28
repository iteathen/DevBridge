import test from 'node:test';
import assert from 'node:assert/strict';
import { HyperVGuestOperation } from '../src/runtime/providers/hyperv-guest-operation.js';

function success(value) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

test('Hyper-V guest operation exposes only locally registered operations through exact ownership and access studs', async () => {
  const calls = [];
  const adapter = new HyperVGuestOperation({
    invoke: async (request) => { calls.push(request); return success({ ok: true, output: '{"ready":true}' }); },
    locate: async () => ({ reference: 'owned-machine', proof: 'owned-proof' }),
    access: async () => ({ user: 'Administrator', secret: 'temporary-secret' }),
    operations: { 'inspect-v1': "if ($operationInput.expected -ne 'value') { throw 'input mismatch' }; @{ ready = $true } | ConvertTo-Json -Compress" },
  });
  assert.deepEqual(await adapter.execute({ target: 'subject-0123456789abcdef0123456789abcdef', operation: 'inspect-v1', input: { expected: 'value' } }), { ready: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'powershell.exe');
  const payload = JSON.parse(calls[0].input);
  assert.equal(payload.reference, 'owned-machine');
  assert.equal(payload.proof, 'owned-proof');
  assert.equal(payload.user, 'Administrator');
  assert.equal(payload.operation.includes('Get-VM'), false);
  assert.equal(Buffer.from(payload.operation, 'base64').toString('utf8').includes('ready = $true'), true);
  const hostScript = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
  assert.match(hostScript, /Get-VM -Name/u);
  assert.match(hostScript, /New-PSSession -VMName/u);
  assert.match(hostScript, /ScriptBlock\]::Create/u);
  assert.match(hostScript, /Remove-PSSession/u);
  assert.doesNotMatch(hostScript, /HyperVGuestOperation|inspect-v1/u);
});

test('Hyper-V guest operation rejects caller-supplied code and unknown operation identities before effects', async () => {
  let calls = 0;
  const adapter = new HyperVGuestOperation({
    invoke: async () => { calls += 1; return success({}); },
    locate: async () => ({ reference: 'owned-machine', proof: 'owned-proof' }),
    access: async () => ({ user: 'Administrator', secret: 'temporary-secret' }),
    operations: { 'inspect-v1': "@{ ready = $true } | ConvertTo-Json -Compress" },
  });
  await assert.rejects(() => adapter.execute({ target: 'subject-0123456789abcdef0123456789abcdef', operation: 'unknown-v1', input: {} }), /not registered/u);
  await assert.rejects(() => adapter.execute({ target: 'subject-0123456789abcdef0123456789abcdef', operation: 'inspect-v1', input: {}, script: 'anything' }), /script is not allowed/u);
  assert.equal(calls, 0);
});

test('Hyper-V guest operation does not leak local access material through failure messages', async () => {
  const secret = 'private-temporary-secret';
  const adapter = new HyperVGuestOperation({
    invoke: async () => ({ ...success({}), exitCode: 1, stderr: `authentication failed for ${secret}` }),
    locate: async () => ({ reference: 'owned-machine', proof: 'owned-proof' }),
    access: async () => ({ user: 'Administrator', secret }),
    operations: { 'inspect-v1': "@{ ready = $true } | ConvertTo-Json -Compress" },
  });
  await assert.rejects(
    () => adapter.execute({ target: 'subject-0123456789abcdef0123456789abcdef', operation: 'inspect-v1', input: {} }),
    (error) => error.message === 'guest operation failed' && !error.message.includes(secret),
  );
});
