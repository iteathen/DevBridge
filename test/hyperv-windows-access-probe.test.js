import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HyperVWindowsAccessProbe } from '../src/runtime/providers/hyperv-windows-access-probe.js';
import { invokeCommand } from '../src/runtime/command-invocation.js';

const identity = 'c'.repeat(32);
const target = `env-${'d'.repeat(32)}`;
const secret = 'Db!A9-private-access-value';
const connection = Object.freeze({ family: 'windows', username: 'devbridge', password: secret });

function evidence(overrides = {}) {
  return {
    ready: true,
    user: 'devbridge',
    accountIdentity: 'S-1-5-21-1-2-3-1001',
    standardAccess: true,
    remoteAccess: true,
    elevated: false,
    bridge: true,
    runtime: true,
    ...overrides,
  };
}

function success(value) {
  return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify({ ok: true, output: JSON.stringify(value) }), stderr: '' };
}

test('Hyper-V Windows access probe binds fixed inspection to exact ownership and non-admin evidence', async () => {
  let supplied;
  const probe = new HyperVWindowsAccessProbe({ identity, invoke: async (request) => { supplied = request; return success(evidence()); } });
  assert.deepEqual(await probe.inspect({ target, connection }), { ready: true, reason: null, accountIdentity: 'S-1-5-21-1-2-3-1001' });
  const payload = JSON.parse(supplied.input);
  assert.equal(payload.reference, `db-env-${createHash('sha256').update(`${identity}:persistent:${target}`).digest('hex').slice(0, 16)}`);
  assert.equal(payload.proof, `devbridge-owned:${identity}:persistent:${target}:v1`);
  assert.equal(payload.user, 'devbridge');
  assert.equal(payload.secret, secret);
  assert.equal(supplied.arguments.includes(secret), false);
  const operation = Buffer.from(payload.operation, 'base64').toString('utf8');
  assert.match(operation, /S-1-5-32-544/u);
  assert.match(operation, /Remote|S-1-5-32-580/u);
  assert.match(operation, /bridge-agent\.mjs/u);
  assert.doesNotMatch(operation, /Get-VM|New-PSSession/u);
});

test('Hyper-V Windows access probe rejects forged evidence and contains access failures', async () => {
  const forged = new HyperVWindowsAccessProbe({ identity, invoke: async () => success(evidence({ elevated: true })) });
  assert.deepEqual(await forged.inspect({ target, connection }), { ready: false, reason: 'access probe evidence is invalid' });

  const unavailable = new HyperVWindowsAccessProbe({
    identity,
    invoke: async () => ({ exitCode: 1, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: `denied ${secret}` }),
  });
  const result = await unavailable.inspect({ target, connection });
  assert.deepEqual(result, { ready: false, reason: 'access endpoint is unavailable' });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Hyper-V Windows access operation is accepted by Windows PowerShell without execution', { skip: process.platform !== 'win32' }, async () => {
  let supplied;
  const probe = new HyperVWindowsAccessProbe({ identity, invoke: async (request) => { supplied = request; return success(evidence()); } });
  await probe.inspect({ target, connection });
  const operation = Buffer.from(JSON.parse(supplied.input).operation, 'base64').toString('utf8');
  const parser = "$ErrorActionPreference='Stop'; $source=[Console]::In.ReadToEnd(); $null=[ScriptBlock]::Create($source); @{ valid=$true } | ConvertTo-Json -Compress";
  const result = await invokeCommand({
    executable: 'powershell.exe',
    arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')],
    input: operation,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true });
});

test('Hyper-V Windows access probe exposes no repository or controller topology', async () => {
  const source = await readFile(new URL('../src/runtime/providers/hyperv-windows-access-probe.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /GitHub|repository[A-Z]|branch|pull request|Codex|CUDA/iu);
});
