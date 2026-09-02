import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../setup/windows-lifecycle-authority-readiness.js';
import { reconcileWindowsElevatedSetupEnvironmentActivation } from './windows-elevated-setup-environment-activation.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-elevated-child-v1';

function childHome(value, env, homeDirectory) {
  const selected = value ?? env.DEVBRIDGE_HOME ?? path.join(homeDirectory, '.devbridge');
  if (typeof selected !== 'string' || selected.length === 0 || selected.includes('\0')) throw new TypeError('DevBridge elevated child home is invalid');
  return path.resolve(selected);
}

function boundedBlocker(value) {
  const text = String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
  return text.length > 0 ? text.slice(0, 2048) : 'Windows lifecycle authority elevated child did not reach protected readiness.';
}

export async function runWindowsLifecycleAuthoritySetupChild({
  home = null,
  env = process.env,
  output = null,
} = {}, {
  platform = process.platform,
  homeDirectory = os.homedir(),
  invoke = invokeCommand,
  reconciler = reconcileWindowsLifecycleAuthorityReadiness,
  activationReconciler = reconcileWindowsElevatedSetupEnvironmentActivation,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows lifecycle authority elevated child is only valid on Windows');
  if (env.DEVBRIDGE_LIFECYCLE_AUTHORITY_ELEVATED_CHILD !== '1') {
    throw new Error('Windows lifecycle authority elevated child requires the bounded UAC parent contract');
  }
  if (typeof invoke !== 'function' || typeof reconciler !== 'function' || typeof activationReconciler !== 'function') {
    throw new TypeError('Windows lifecycle authority elevated child composition is invalid');
  }
  const root = childHome(home, env, homeDirectory);
  const stateDirectory = path.join(root, 'state');
  const result = await reconciler({
    stateDirectory,
    platform,
    invoke,
    environment: env,
    mode: 'elevated-child',
    requestElevation: null,
    onDiagnostic: output && typeof output.write === 'function'
      ? (event) => output.write(`${JSON.stringify(event)}\n`)
      : null,
  });
  const activation = result?.ready === true
    ? await activationReconciler({ stateDirectory, platform })
    : null;
  const ready = result?.ready === true && activation?.ready === true;
  return Object.freeze({
    protocol: PROTOCOL,
    ready,
    changed: result?.changed === true || activation?.changed === true,
    service: typeof result?.service === 'string' ? result.service : 'unknown',
    protectedState: typeof result?.protectedState === 'string' ? result.protectedState : 'unknown',
    blocker: ready ? null : boundedBlocker(result?.ready === true ? activation?.blocker : result?.blocker),
  });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ELEVATED_CHILD_PROTOCOL };
