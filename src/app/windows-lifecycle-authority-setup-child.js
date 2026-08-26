import os from 'node:os';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../setup/windows-lifecycle-authority-readiness.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-elevated-child-v1';
const RESULT_DIRECTORY = /^\.lifecycle-authority-elevation-[0-9a-f-]{36}$/u;
const MAX_RESULT_BYTES = 8 * 1024;

function childHome(value, env, homeDirectory) {
  const selected = value ?? env.DEVBRIDGE_HOME ?? path.join(homeDirectory, '.devbridge');
  if (typeof selected !== 'string' || selected.length === 0 || selected.includes('\0')) throw new TypeError('DevBridge elevated child home is invalid');
  return path.resolve(selected);
}

function boundedBlocker(value) {
  const text = String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
  return text.length > 0 ? text.slice(0, 2048) : 'Windows lifecycle authority elevated child did not reach protected readiness.';
}

async function writeBoundedResult(root, env, result) {
  const selected = env.DEVBRIDGE_LIFECYCLE_AUTHORITY_CHILD_RESULT;
  if (typeof selected !== 'string' || selected.length === 0 || selected.includes('\0') || !path.isAbsolute(selected)) {
    throw new Error('Windows lifecycle authority elevated child result path is invalid');
  }
  const file = path.resolve(selected);
  const state = path.join(root, 'state');
  const directory = path.dirname(file);
  if (path.basename(file) !== 'result.json' || path.dirname(directory) !== state || !RESULT_DIRECTORY.test(path.basename(directory))) {
    throw new Error('Windows lifecycle authority elevated child result escaped the bounded parent channel');
  }
  const [stateInfo, directoryInfo] = await Promise.all([lstat(state), lstat(directory)]);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('Windows lifecycle authority elevated child result channel is not a real directory');
  }
  const canonicalState = await realpath(state);
  const canonicalDirectory = await realpath(directory);
  if (path.dirname(canonicalDirectory).toLowerCase() !== canonicalState.toLowerCase()) {
    throw new Error('Windows lifecycle authority elevated child result channel escaped canonical state');
  }
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`, 'utf8');
  if (bytes.length < 2 || bytes.length > MAX_RESULT_BYTES) throw new Error('Windows lifecycle authority elevated child result is unbounded');
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
}

export async function runWindowsLifecycleAuthoritySetupChild({
  home = null,
  env = process.env,
} = {}, {
  platform = process.platform,
  homeDirectory = os.homedir(),
  invoke = invokeCommand,
  reconciler = reconcileWindowsLifecycleAuthorityReadiness,
  resultWriter = writeBoundedResult,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows lifecycle authority elevated child is only valid on Windows');
  if (env.DEVBRIDGE_LIFECYCLE_AUTHORITY_ELEVATED_CHILD !== '1') {
    throw new Error('Windows lifecycle authority elevated child requires the bounded UAC parent contract');
  }
  if (typeof invoke !== 'function' || typeof reconciler !== 'function' || typeof resultWriter !== 'function') throw new TypeError('Windows lifecycle authority elevated child composition is invalid');
  const root = childHome(home, env, homeDirectory);
  const result = await reconciler({
    stateDirectory: path.join(root, 'state'),
    platform,
    invoke,
    environment: env,
    mode: 'elevated-child',
    requestElevation: null,
  });
  const childResult = Object.freeze({
    protocol: PROTOCOL,
    ready: result?.ready === true,
    changed: result?.changed === true,
    service: typeof result?.service === 'string' ? result.service : 'unknown',
    protectedState: typeof result?.protectedState === 'string' ? result.protectedState : 'unknown',
    blocker: result?.ready === true ? null : boundedBlocker(result?.blocker),
  });
  await resultWriter(root, env, childResult);
  return childResult;
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ELEVATED_CHILD_PROTOCOL };
