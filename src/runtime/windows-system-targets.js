import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const WINDOWS_SYSTEM_TARGET = Object.freeze({
  CUDA_DRIVER_LIBRARY: 'cuda-driver-library',
  NVIDIA_SMI: 'nvidia-smi',
  WSL_RUNTIME: 'wsl-runtime',
});

const SYSTEM32_GLOBALROOT = '\\\\?\\GLOBALROOT\\SystemRoot\\System32';
const TARGET_FILE = Object.freeze({
  [WINDOWS_SYSTEM_TARGET.CUDA_DRIVER_LIBRARY]: 'nvcuda.dll',
  [WINDOWS_SYSTEM_TARGET.NVIDIA_SMI]: 'nvidia-smi.exe',
  [WINDOWS_SYSTEM_TARGET.WSL_RUNTIME]: 'wsl.exe',
});

function normalizedWindowsPath(value) {
  let result = path.win32.normalize(String(value));
  if (result.startsWith('\\\\?\\')) result = result.slice(4);
  return result.toLowerCase();
}

function sameWindowsPath(left, right) {
  return normalizedWindowsPath(left) === normalizedWindowsPath(right);
}

function requireTarget(value) {
  if (!Object.values(WINDOWS_SYSTEM_TARGET).includes(value)) {
    throw new TypeError('Windows system target is unsupported');
  }
  return value;
}

async function regularNonLink(filePath, lstatPath) {
  try {
    const info = await lstatPath(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function realDirectory(directoryPath, { lstatPath, realpathPath }) {
  try {
    const resolved = await realpathPath(directoryPath);
    const info = await lstatPath(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return resolved;
  } catch {
    return null;
  }
}

export async function resolveWindowsSystemTarget(rawTarget, {
  platform = process.platform,
  lstatPath = lstat,
  realpathPath = realpath,
} = {}) {
  const target = requireTarget(rawTarget);
  if (platform !== 'win32') return null;
  if (typeof lstatPath !== 'function' || typeof realpathPath !== 'function') {
    throw new TypeError('Windows system target filesystem authority is incomplete');
  }

  const system32 = await realDirectory(SYSTEM32_GLOBALROOT, { lstatPath, realpathPath });
  if (!system32) return null;

  const candidate = path.win32.join(SYSTEM32_GLOBALROOT, TARGET_FILE[target]);
  if (!(await regularNonLink(candidate, lstatPath))) return null;

  let resolved;
  try { resolved = await realpathPath(candidate); }
  catch { return null; }

  if (!sameWindowsPath(path.win32.dirname(resolved), system32)) return null;
  if (!(await regularNonLink(resolved, lstatPath))) return null;
  return resolved;
}
