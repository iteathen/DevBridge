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
    'ExclusivePipeServerInstances = 1',
    'FILE_FLAG_FIRST_PIPE_INSTANCE',
    'JobObjectLimitKillOnJobClose',
    'UseShellExecute = false',
    'Environment.FailFast',
    'ScrubbedWorkerEnvironment',
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
    'PipeAccessRights.CreateNewInstance',
  ]) assert.equal(source.includes(forbidden), false, `service host leaked ${forbidden}`);

  assert.match(source, /administrators, PipeAccessRights\.ReadWrite/u);
  assert.doesNotMatch(source, /administrators, PipeAccessRights\.FullControl/u);
  assert.match(source, /operatorIdentity, PipeAccessRights\.ReadWrite/u);
  assert.equal(source.includes('operatorIdentity, PipeAccessRights.FullControl'), false);
});

test('Windows lifecycle endpoints keep one first-instance server alive across requests', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.match(source, /private const int ExclusivePipeServerInstances = 1;/u);
  assert.match(
    source,
    /PipeDirection\.InOut,\s*ExclusivePipeServerInstances,\s*PipeTransmissionMode\.Byte,\s*PipeOptions\.Asynchronous,/su,
  );
  assert.doesNotMatch(source, /PipeOptions\.FirstPipeInstance/u);
  assert.match(source, /pipe = CreatePipe\(name, access\);\s*lock \(activeLock\) activePipes\.Add\(pipe\);\s*while \(!stopping\)/su);
  assert.match(source, /if \(!stopping && pipe\.IsConnected\) pipe\.Disconnect\(\);/u);
  assert.equal((source.match(/CreatePipe\(name, access\)/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /while \(!stopping\)[\s\S]{0,300}pipe = CreatePipe/u);
  assert.match(source, /if \(!read\.Wait\(remaining\)\) throw new System\.TimeoutException/u);
  assert.doesNotMatch(source, /if \(!read\.Wait\(remaining\)\)[\s\S]{0,160}pipe\.Dispose/u);
});

test('Windows lifecycle worker cannot inherit common operator credential channels', async () => {
  const source = await readFile(SOURCE, 'utf8');
  for (const name of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'DEVBRIDGE_GITHUB_TOKEN',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'SSH_AUTH_SOCK',
    'DEVBRIDGE_COORDINATION_PRIVATE_KEY',
    'DEVBRIDGE_RELEASE_PRIVATE_KEY',
    'DEVBRIDGE_SIGNING_KEY',
  ]) assert.equal(source.includes(`\"${name}\"`), true, `worker scrub list lost ${name}`);
  assert.match(source, /foreach \(string name in ScrubbedWorkerEnvironment\) start\.EnvironmentVariables\.Remove\(name\);/u);
});

test('Windows PowerShell 5.1 one-instance pipe rejects a competing server namespace', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows pipe exclusivity qualification runs on Windows CI');
  const pipeName = `devbridge-ci-first-instance-${process.pid}-${Date.now()}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$first = $null',
    '$second = $null',
    'try {',
    "  $first = New-Object System.IO.Pipes.NamedPipeServerStream($env:DB_PIPE_NAME, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096)",
    '  try {',
    "    $second = New-Object System.IO.Pipes.NamedPipeServerStream($env:DB_PIPE_NAME, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096)",
    "    throw 'competing named-pipe server was admitted'",
    '  } catch [System.IO.IOException] {',
    '  }',
    '} finally {',
    '  if ($second -ne $null) { $second.Dispose() }',
    '  if ($first -ne $null) { $first.Dispose() }',
    '}',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, DB_PIPE_NAME: pipeName },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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
