import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WINDOWS_SYSTEM_TARGET,
  resolveWindowsSystemTarget,
} from '../src/runtime/windows-system-targets.js';

function directoryInfo() {
  return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}

function fileInfo({ symlink = false } = {}) {
  return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => symlink };
}

function fakeFs({ escapedTarget = false, targetSymlink = false } = {}) {
  const lstatPath = async (value) => {
    const text = String(value).toLowerCase();
    if (text.endsWith('\\system32')) return directoryInfo();
    if (text.endsWith('\\wsl.exe') || text.endsWith('\\nvidia-smi.exe') || text.endsWith('\\nvcuda.dll')) {
      return fileInfo({ symlink: targetSymlink });
    }
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  const realpathPath = async (value) => {
    const text = String(value).toLowerCase();
    if (text.endsWith('\\system32')) return 'C:\\Windows\\System32';
    if (text.endsWith('\\wsl.exe')) return escapedTarget ? 'C:\\Users\\Public\\wsl.exe' : 'C:\\Windows\\System32\\wsl.exe';
    if (text.endsWith('\\nvidia-smi.exe')) return 'C:\\Windows\\System32\\nvidia-smi.exe';
    if (text.endsWith('\\nvcuda.dll')) return 'C:\\Windows\\System32\\nvcuda.dll';
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  return { lstatPath, realpathPath };
}

test('closed Windows system targets resolve only beneath the OS-owned System32 root', async () => {
  const fs = fakeFs();
  assert.equal(
    await resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.WSL_RUNTIME, { platform: 'win32', ...fs }),
    'C:\\Windows\\System32\\wsl.exe',
  );
  assert.equal(
    await resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.NVIDIA_SMI, { platform: 'win32', ...fs }),
    'C:\\Windows\\System32\\nvidia-smi.exe',
  );
  assert.equal(
    await resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.CUDA_DRIVER_LIBRARY, { platform: 'win32', ...fs }),
    'C:\\Windows\\System32\\nvcuda.dll',
  );
});

test('Windows system target resolver rejects unknown logical targets', async () => {
  await assert.rejects(
    () => resolveWindowsSystemTarget('cmd-or-anything', { platform: 'win32', ...fakeFs() }),
    /system target is unsupported/u,
  );
});

test('Windows system target resolver rejects canonical escape and target symlink substitution', async () => {
  assert.equal(
    await resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.WSL_RUNTIME, { platform: 'win32', ...fakeFs({ escapedTarget: true }) }),
    null,
  );
  assert.equal(
    await resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.WSL_RUNTIME, { platform: 'win32', ...fakeFs({ targetSymlink: true }) }),
    null,
  );
});

test('non-Windows hosts do not touch Windows system target filesystem authority', async () => {
  let touched = 0;
  const result = await resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.WSL_RUNTIME, {
    platform: 'linux',
    lstatPath: async () => { touched += 1; throw new Error('unexpected'); },
    realpathPath: async () => { touched += 1; throw new Error('unexpected'); },
  });
  assert.equal(result, null);
  assert.equal(touched, 0);
});

test('Windows accelerator adapters no longer derive executable identity from inherited roots', async () => {
  for (const relative of [
    '../src/runtime/accelerators/windows-native-cuda-backend-inventory.js',
    '../src/runtime/accelerators/windows-wsl-cuda-backend-inventory.js',
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    for (const forbidden of ['process.env', 'ProgramFiles', 'ProgramW6432', 'WINDIR', 'localCandidates(', 'executableCandidates(']) {
      assert.equal(source.includes(forbidden), false, `${relative}: ${forbidden}`);
    }
    assert.equal(source.includes('resolveWindowsSystemTarget'), true, relative);
  }
});

test('real Windows GLOBALROOT resolution ignores poisoned inherited Windows roots', { skip: process.platform !== 'win32' }, async () => {
  const names = ['SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramW6432'];
  const before = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'Z:\\DevBridge-Poisoned-Root';
    const resolved = await resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.WSL_RUNTIME);
    assert.ok(resolved, 'the fixed Windows WSL system target should resolve on the hosted Windows image');
    assert.match(resolved, /\\System32\\wsl\.exe$/iu);
    assert.equal(resolved.toLowerCase().includes('devbridge-poisoned-root'), false);
  } finally {
    for (const [name, value] of before) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
