import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsFileLease } from '../src/runtime/windows-file-lease.js';

test('Windows lease uses the compiled host and releases on holder and requester death', { skip: process.platform !== 'win32', timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-lease-'));
  const children = new Set();
  t.after(async () => {
    for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
    await Promise.all([...children].filter((child) => child.exitCode == null && child.signalCode == null).map((child) => once(child, 'close')));
    await rm(root, { recursive: true, force: true });
  });
  const holderExecutable = path.join(root, 'host.exe');
  const source = fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-host.cs', import.meta.url));
  const script = `Add-Type -LiteralPath $env:DB_LEASE_SOURCE -OutputAssembly $env:DB_LEASE_OUTPUT -OutputType ConsoleApplication -ReferencedAssemblies 'System.ServiceProcess.dll'
Add-Type -TypeDefinition 'using System.Text; using System.Runtime.InteropServices; public static class LeaseShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetShortPathName(string path, StringBuilder output, uint length); }'
$buffer = New-Object Text.StringBuilder 4096
if ([LeaseShortPath]::GetShortPathName([IO.Path]::GetDirectoryName($env:DB_LEASE_OUTPUT), $buffer, 4096) -eq 0) { throw 'short path lookup failed' }
[Console]::Write($buffer.ToString())`;
  const compiled = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DB_LEASE_SOURCE: source, DB_LEASE_OUTPUT: holderExecutable },
  });
  assert.equal(compiled.status, 0, compiled.stderr);
  // CI commonly supplies an 8.3 TEMP path. Exercise that spelling locally too.
  const subjectPath = path.join(compiled.stdout.trim(), 'mutation.lease');
  let holder;
  const tracked = (executable, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    const child = spawn(executable, args, options);
    children.add(child);
    holder = child;
    return child;
  };
  const factory = () => createWindowsFileLease({ subjectPath, holderExecutable }, { spawnProcess: tracked });
  const first = await factory().acquire({ mode: 'exclusive' });
  first.assertHeld();
  const firstHolder = holder;
  const competitor = createWindowsFileLease({ subjectPath, holderExecutable }, {
    spawnProcess: tracked,
    timingPolicy: { sharedAcquireMs: 200, exclusiveAcquireMs: 200, releaseMs: 2000, killMs: 1000 },
  });
  await assert.rejects(competitor.acquire({ mode: 'exclusive' }), /did not complete in time/u);
  first.assertHeld();
  const holderClosed = once(firstHolder, 'close');
  firstHolder.kill();
  await holderClosed;
  assert.equal(first.signal.aborted, true);
  assert.throws(() => first.assertHeld(), /ended unexpectedly/u);
  await assert.rejects(first.release(), /ended unexpectedly/u);
  const replacement = await factory().acquire({ mode: 'exclusive' });
  replacement.assertHeld();
  await replacement.release();

  const requesterFile = path.join(root, 'requester.mjs');
  await writeFile(requesterFile, `import { createWindowsFileLease } from ${JSON.stringify(new URL('../src/runtime/windows-file-lease.js', import.meta.url).href)};
const lease = await createWindowsFileLease(${JSON.stringify({ subjectPath, holderExecutable })}).acquire({ mode: 'exclusive' });
process.stdout.write('HELD\\n');
process.stdin.resume();
process.stdin.once('end', () => lease.release());
`);
  const requester = spawn(process.execPath, [requesterFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  children.add(requester);
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('requester did not acquire lease')), 10_000);
    requester.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('HELD\n')) { clearTimeout(timer); resolve(); }
    });
    requester.once('exit', (code) => { clearTimeout(timer); reject(new Error(`requester exited ${code}`)); });
  });
  const requesterClosed = once(requester, 'close');
  requester.kill();
  await requesterClosed;
  const recovered = await factory().acquire({ mode: 'exclusive' });
  recovered.assertHeld();
  await recovered.release();
});
