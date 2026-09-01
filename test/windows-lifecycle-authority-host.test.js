import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createConfiguredEnvironmentConfigurationClient } from '../src/runtime/environment-configuration-authority-transport.js';
import { createWindowsLifecycleAuthorityPlan } from '../src/setup/windows-lifecycle-authority.js';

const SOURCE = fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-host.cs', import.meta.url));

function waitForHostReady(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`compiled host readiness timed out: ${stdout}\n${stderr}`)), timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk) => {
      stdout += chunk;
      if (stdout.split(/\r?\n/u).includes('READY')) finish();
    };
    const onStderr = (chunk) => { stderr += chunk; };
    const onExit = (code) => finish(new Error(`compiled host exited before readiness (${String(code)}): ${stdout}\n${stderr}`));
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('compiled host did not stop within its bounded teardown window'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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
    'acceptanceThread',
    'options.AcceptancePipe',
    'activityThread',
    'options.ActivityPipe',
    'configurationThread',
    'options.ConfigurationPipe',
  ]) assert.equal(source.includes(required), true, `service host lost ${required}`);

  for (const forbidden of [
    'Remove-VM',
    'Get-VM',
    'New-VM',
    'New-VHD',
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

test('Windows lifecycle ordinary capabilities remain distinct without widening the mutation pipe', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.match(source, /String\.Equals\(access, "read", StringComparison\.Ordinal\) \|\| String\.Equals\(access, "acceptance", StringComparison\.Ordinal\) \|\| String\.Equals\(access, "activity", StringComparison\.Ordinal\) \|\| String\.Equals\(access, "configuration", StringComparison\.Ordinal\)/u);
  assert.doesNotMatch(source, /String\.Equals\(access, "mutation", StringComparison\.Ordinal\)[^\n]*operatorIdentity/u);
  assert.match(source, /Serve\(options\.AcceptancePipe, "acceptance"\)/u);
  assert.match(source, /--acceptance-pipe/u);
  assert.match(source, /Serve\(options\.ActivityPipe, "activity"\)/u);
  assert.match(source, /--activity-pipe/u);
  assert.match(source, /Serve\(options\.ConfigurationPipe, "configuration"\)/u);
  assert.match(source, /--configuration-pipe/u);
  assert.match(source, /pipe capabilities must be distinct/u);
  assert.match(source, /S-1-5-2/u);
  assert.match(source, /network, PipeAccessRights\.FullControl, AccessControlType\.Deny/u);
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
  assert.doesNotMatch(source, /while \(!stopping\)[\s\S]{0,300}pipe = CreatePipe/u);
  assert.match(source, /if \(!read\.Wait\(remaining\)\) throw new System\.TimeoutException/u);
  assert.doesNotMatch(source, /if \(!read\.Wait\(remaining\)\)[\s\S]{0,160}pipe\.Dispose/u);
});

test('Windows protected activity workers are bounded by client lifetime without widening other worker protocols', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.match(source, /private const int ActivityWorkerTimeoutMs = 300000;/u);
  assert.match(source, /InvokeWorker\(access, request, responseLimit, pipe\)/u);
  assert.match(source, /Task<int> clientMonitor = clientPipe\.ReadAsync\(clientProbe, 0, clientProbe\.Length\);/u);
  assert.match(source, /Task\.WaitAny\(new Task\[\] \{ read, clientMonitor \}, remaining\)/u);
  assert.match(source, /CancelIoEx\(clientPipe\.SafePipeHandle\.DangerousGetHandle\(\), IntPtr\.Zero\)/u);
  assert.match(source, /String\.Equals\(access, "activity", StringComparison\.Ordinal\)\s*\? ReadActivityWorkerResponse\(worker, clientPipe, maxResponseBytes\)\s*:\s*ReadWorkerResponse\(worker, maxResponseBytes\)/su);
  assert.match(source, /catch \(IOException\)\s*\{\s*continue;\s*\}/su);
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

test('compiled Windows host serves configuration through its distinct five-endpoint plan', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows compiled-host integration runs on Windows CI');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'devbridge-lifecycle-host-integration-'));
  const library = path.join(temp, 'devbridge-lifecycle-authority-host.dll');
  const harnessSource = path.join(temp, 'integration-harness.cs');
  const harness = path.join(temp, 'integration-harness.exe');
  let child = null;
  try {
    const sidResult = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(sidResult.error, undefined, sidResult.error?.message);
    assert.equal(sidResult.status, 0, `${sidResult.stdout}\n${sidResult.stderr}`);
    const operatorSid = sidResult.stdout.trim();
    const stateDirectory = path.join(temp, 'operator-state');
    const plan = createWindowsLifecycleAuthorityPlan({
      stateDirectory,
      programDataDirectory: temp,
      operatorSid,
    });
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(plan.protectedRoot, { recursive: true });
    await mkdir(plan.authorityDirectory, { recursive: true });
    const node = path.join(plan.protectedRoot, 'node.exe');
    const worker = path.join(plan.protectedRoot, 'worker.mjs');
    await writeFile(worker, [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) input += chunk;",
      "const request = JSON.parse(input.trim());",
      "const access = process.argv[process.argv.indexOf('--access') + 1];",
      "if (access !== 'configuration') process.exit(2);",
      "process.stdout.write(JSON.stringify({ protocol: 'devbridge/environment-configuration-authority-result-v1', requestId: request.requestId, ok: true, value: { ready: true } }) + '\\n');",
    ].join('\n'));
    await writeFile(harnessSource, String.raw`using System;
using System.Reflection;

internal static class IntegrationHarness
{
    private static int Main(string[] args)
    {
        object service = null;
        MethodInfo stop = null;
        try
        {
            Assembly host = Assembly.LoadFrom(Environment.GetEnvironmentVariable("DB_HOST_LIBRARY"));
            Type optionsType = host.GetType("DevBridge.WindowsLifecycleAuthority.HostOptions", true);
            Type serviceType = host.GetType("DevBridge.WindowsLifecycleAuthority.LifecycleAuthorityService", true);
            MethodInfo parse = optionsType.GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic);
            object options = parse.Invoke(null, new object[] { args });
            service = Activator.CreateInstance(serviceType, BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { options }, null);
            MethodInfo start = serviceType.GetMethod("OnStart", BindingFlags.Instance | BindingFlags.NonPublic);
            stop = serviceType.GetMethod("OnStop", BindingFlags.Instance | BindingFlags.NonPublic);
            start.Invoke(service, new object[] { new string[0] });
            Console.WriteLine("READY");
            Console.Out.Flush();
            Console.ReadLine();
            return 0;
        }
        finally
        {
            if (service != null && stop != null) stop.Invoke(service, null);
        }
    }
}`);
    const compileScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -LiteralPath $env:DB_HOST_SOURCE -OutputAssembly $env:DB_HOST_LIBRARY -OutputType Library -ReferencedAssemblies 'System.ServiceProcess.dll'",
      "Add-Type -LiteralPath $env:DB_HARNESS_SOURCE -OutputAssembly $env:DB_HARNESS_OUTPUT -OutputType ConsoleApplication",
    ].join('; ');
    const compile = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', compileScript,
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: {
        ...process.env,
        DB_HOST_SOURCE: SOURCE,
        DB_HOST_LIBRARY: library,
        DB_HARNESS_SOURCE: harnessSource,
        DB_HARNESS_OUTPUT: harness,
      },
    });
    assert.equal(compile.error, undefined, compile.error?.message);
    assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
    await copyFile(process.execPath, node);

    const endpointArgs = ['read', 'mutation', 'acceptance', 'activity', 'configuration']
      .flatMap((capability) => [`--${capability}-pipe`, plan.endpoints[capability].pipeName]);
    child = spawn(harness, [
      '--service-name', plan.service.name,
      '--protected-root', plan.protectedRoot,
      '--node', node,
      '--worker', worker,
      '--state-directory', stateDirectory,
      '--authority-directory', plan.authorityDirectory,
      '--operator-sid', operatorSid,
      ...endpointArgs,
    ], {
      cwd: plan.protectedRoot,
      env: { ...process.env, DB_HOST_LIBRARY: library },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForHostReady(child);
    for (let request = 0; request < 30; request += 1) {
      let result;
      try {
        result = await createConfiguredEnvironmentConfigurationClient({
          stateDirectory,
          platform: 'win32',
          connectTimeoutMs: 1_000,
        }).inspect();
      } catch (error) {
        throw new Error(`compiled configuration endpoint failed on request ${String(request + 1)}: ${error.message}`);
      }
      assert.deepEqual(result, { ready: true });
    }
    child.stdin.end('\n');
    assert.equal(await waitForExit(child), 0);
    child = null;
  } finally {
    if (child && child.exitCode == null) {
      child.stdin.end('\n');
      try { await waitForExit(child, 10_000); } catch { child.kill(); }
    }
    await rm(temp, { recursive: true, force: true });
  }
});
