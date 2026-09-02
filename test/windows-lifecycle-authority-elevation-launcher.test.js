import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import {
  prepareWindowsLifecycleAuthorityElevationLauncher,
  resolveWindowsLifecycleAuthorityElevationLauncher,
  windowsLifecycleAuthorityElevationPurpose,
} from '../src/setup/windows-lifecycle-authority-elevation-launcher.js';

const SOURCE = new URL('../src/setup/windows-lifecycle-authority-elevation-launcher.cs', import.meta.url);
const MANIFEST = new URL('../src/setup/windows-lifecycle-authority-elevation-launcher.manifest', import.meta.url);
const HEAD = 'a'.repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-elevation-launcher-'));
  const home = path.join(root, 'home');
  const runnerRoot = path.join(root, 'runner');
  const launcher = path.join(runnerRoot, 'src', 'cli.js');
  await mkdir(path.join(home, 'state'), { recursive: true });
  await mkdir(path.join(runnerRoot, '.git'), { recursive: true });
  await mkdir(path.join(runnerRoot, 'src', 'setup'), { recursive: true });
  await writeFile(path.join(runnerRoot, '.git', 'HEAD'), `${HEAD}\n`);
  await writeFile(launcher, 'export {};\n');
  await copyFile(SOURCE, path.join(runnerRoot, 'src', 'setup', 'windows-lifecycle-authority-elevation-launcher.cs'));
  await copyFile(MANIFEST, path.join(runnerRoot, 'src', 'setup', 'windows-lifecycle-authority-elevation-launcher.manifest'));
  return Object.freeze({
    root,
    home,
    runner: Object.freeze({ head: HEAD, root: runnerRoot, launcher }),
  });
}

test('non-Windows elevation launcher preparation is an exact no-op', async () => {
  const result = await prepareWindowsLifecycleAuthorityElevationLauncher({ platform: 'linux' });
  assert.deepEqual(result, { protocol: 'devbridge/windows-lifecycle-authority-elevation-launcher-v1', prepared: false, required: false, launcher: null });
});

test('Windows elevation launcher compiles one identified exact artifact and reuses it', {
  skip: process.platform !== 'win32',
}, async () => {
  const selected = await fixture();
  try {
    const options = { home: selected.home, runner: selected.runner, platform: 'win32', nodeExecutable: process.execPath };
    const first = await prepareWindowsLifecycleAuthorityElevationLauncher(options);
    const repeated = await prepareWindowsLifecycleAuthorityElevationLauncher(options);
    assert.equal(first.prepared, true);
    assert.equal(first.changed, true);
    assert.equal(repeated.prepared, true);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.launcher.executable, first.launcher.executable);
    assert.equal(path.basename(repeated.launcher.executable), 'DevBridge-Protected-Setup-Reconcile-Lifecycle-Service-and-Environment.exe');
    assert.equal(repeated.launcher.fileDescription, 'DevBridge Protected Setup - reconcile lifecycle service and protected environment');
    assert.equal(repeated.launcher.purpose, windowsLifecycleAuthorityElevationPurpose());
    assert.deepEqual(repeated.launcher.input, first.launcher.input);

    const identity = await invokeCommand({
      executable: first.launcher.executable,
      arguments: ['--identity'],
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
    });
    assert.equal(identity.exitCode, 0, identity.stderr);
    assert.deepEqual(JSON.parse(identity.stdout.trim()), {
      protocol: 'devbridge/windows-lifecycle-authority-elevation-launcher-v1',
      fileDescription: 'DevBridge Protected Setup - reconcile lifecycle service and protected environment',
      purpose: 'Reconcile the DevBridge-owned lifecycle service and protected environment configuration',
      executionLevel: 'asInvoker',
      uiAccess: false,
    });

    const manifest = await readFile(MANIFEST, 'utf8');
    assert.match(manifest, /requestedExecutionLevel level="asInvoker" uiAccess="false"/u);
  } finally {
    await rm(selected.root, { recursive: true, force: true });
  }
});

test('Windows elevation launcher rejects exact artifact or runner drift', {
  skip: process.platform !== 'win32',
}, async () => {
  const selected = await fixture();
  try {
    const options = { home: selected.home, runner: selected.runner, platform: 'win32', nodeExecutable: process.execPath };
    const prepared = await prepareWindowsLifecycleAuthorityElevationLauncher(options);
    await appendFile(prepared.launcher.executable, 'drift');
    await assert.rejects(resolveWindowsLifecycleAuthorityElevationLauncher(options), /identity changed/u);
    await writeFile(path.join(selected.runner.root, '.git', 'HEAD'), `${'b'.repeat(40)}\n`);
    await assert.rejects(resolveWindowsLifecycleAuthorityElevationLauncher(options), /runner head changed/u);
  } finally {
    await rm(selected.root, { recursive: true, force: true });
  }
});
