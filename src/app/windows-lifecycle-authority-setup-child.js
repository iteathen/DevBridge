import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../setup/windows-lifecycle-authority-readiness.js';
import { createWindowsEnvironmentProfileConfiguration } from '../setup/windows-environment-profile-configuration.js';

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
  configurationFactory = createWindowsEnvironmentProfileConfiguration,
} = {}) {
  if (platform !== 'win32') throw new Error('Windows lifecycle authority elevated child is only valid on Windows');
  if (env.DEVBRIDGE_LIFECYCLE_AUTHORITY_ELEVATED_CHILD !== '1') {
    throw new Error('Windows lifecycle authority elevated child requires the bounded UAC parent contract');
  }
  if (typeof invoke !== 'function' || typeof reconciler !== 'function' || typeof configurationFactory !== 'function') throw new TypeError('Windows lifecycle authority elevated child composition is invalid');
  const root = childHome(home, env, homeDirectory);
  const stateDirectory = path.join(root, 'state');
  const result = await reconciler({
    stateDirectory,
    platform,
    invoke,
    environment: env,
    mode: 'elevated-child',
    requestElevation: null,
    configuration: configurationFactory({ stateDirectory, platform, invoke }),
    onDiagnostic: output && typeof output.write === 'function'
      ? (event) => output.write(`${JSON.stringify(event)}\n`)
      : null,
  });
  return Object.freeze({
    protocol: PROTOCOL,
    ready: result?.ready === true,
    changed: result?.changed === true,
    service: typeof result?.service === 'string' ? result.service : 'unknown',
    protectedState: typeof result?.protectedState === 'string' ? result.protectedState : 'unknown',
    blocker: result?.ready === true ? null : boundedBlocker(result?.blocker),
  });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ELEVATED_CHILD_PROTOCOL };
