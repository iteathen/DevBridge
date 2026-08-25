import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-host.cs', import.meta.url));

test('Windows lifecycle service host is only an SCM, IPC, and bounded process adapter', async () => {
  const source = await readFile(SOURCE, 'utf8');
  for (const required of [
    'ServiceBase.Run',
    'NamedPipeServerStream',
    'PipeAccessRights.ReadWrite',
    'JobObjectLimitKillOnJobClose',
    'UseShellExecute = false',
    'NODE_OPTIONS',
  ]) assert.equal(source.includes(required), true, `service host lost ${required}`);

  for (const forbidden of [
    'Remove-VM',
    'Get-VM',
    'New-VM',
    'Set-VM',
    'PersistentEnvironments',
    'EnvironmentOperator',
    'PowerShell',
    'cmd.exe',
    'powershell.exe',
    'virsh',
  ]) assert.equal(source.includes(forbidden), false, `service host leaked ${forbidden}`);

  assert.match(source, /administrators, PipeAccessRights\.ReadWrite/u);
  assert.doesNotMatch(source, /administrators, PipeAccessRights\.FullControl/u);
  assert.match(source, /operatorIdentity, PipeAccessRights\.ReadWrite/u);
  assert.equal(source.includes('operatorIdentity, PipeAccessRights.FullControl'), false);
});

test('Windows PowerShell 5.1 can compile the service-aware host without a third-party build tool', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows compiler qualification runs on Windows CI');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'devbridge-lifecycle-host-'));
  const output = path.join(temp, 'devbridge-lifecycle-authority-host.exe');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -LiteralPath $env:DB_HOST_SOURCE -OutputAssembly $env:DB_HOST_OUTPUT -OutputType ConsoleApplication -ReferencedAssemblies 'System.ServiceProcess.dll'",
    "if (-not (Test-Path -LiteralPath $env:DB_HOST_OUTPUT -PathType Leaf)) { throw 'service host output is missing' }",
  ].join('; ');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, DB_HOST_SOURCE: SOURCE, DB_HOST_OUTPUT: output },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
