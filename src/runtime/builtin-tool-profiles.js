import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const NATIVE_COMPILER_DIAGNOSTIC_PROFILE = 'patch-poller-native-compiler';
export const TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE = 'patch-poller-transient-recovery';
export const CHAT_C_PROJECT_DIAGNOSTIC_PROFILE = 'patch-poller-chat-c-project';

const NATIVE_COMPILER_CLI = fileURLToPath(new URL('./native-compiler-probe-cli.js', import.meta.url));
const TRANSIENT_RECOVERY_CLI = fileURLToPath(new URL('./transient-recovery-probe-cli.js', import.meta.url));
const CHAT_C_PROJECT_CLI = fileURLToPath(new URL('./chat-c-project-probe-cli.js', import.meta.url));

function windowsToolchainEnvironment() {
  return {
    pass: [
      'PATH', 'Path', 'PATHEXT',
      'SYSTEMROOT', 'WINDIR', 'SystemDrive',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'TEMP', 'TMP', 'TMPDIR'
    ],
    set: {}
  };
}

export function nativeCompilerDiagnosticProfile() {
  return {
    name: NATIVE_COMPILER_DIAGNOSTIC_PROFILE,
    executable: process.execPath,
    args: [NATIVE_COMPILER_CLI],
    inputMode: 'stdin-json',
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
    environment: windowsToolchainEnvironment(),
    // This launches PATCH-POLLER-owned deterministic code, not an untrusted
    // proposal engine. It still runs shell:false and performs only fixed local
    // discovery/compile operations with no network access.
    sandbox: {
      enforcement: 'os',
      outsideProjectRead: 'readonly',
      outsideProjectWrite: false,
      network: 'deny'
    }
  };
}

export function transientRecoveryDiagnosticProfile() {
  return {
    name: TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE,
    executable: process.execPath,
    args: [TRANSIENT_RECOVERY_CLI],
    inputMode: 'stdin-json',
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    environment: { pass: [], set: {} },
    sandbox: {
      enforcement: 'os',
      outsideProjectRead: 'deny',
      outsideProjectWrite: false,
      network: 'deny'
    }
  };
}

export function chatCProjectDiagnosticProfile() {
  return {
    name: CHAT_C_PROJECT_DIAGNOSTIC_PROFILE,
    executable: process.execPath,
    args: [CHAT_C_PROJECT_CLI],
    inputMode: 'stdin-json',
    timeoutMs: 180_000,
    maxOutputBytes: 512 * 1024,
    environment: windowsToolchainEnvironment(),
    sandbox: {
      enforcement: 'os',
      outsideProjectRead: 'readonly',
      outsideProjectWrite: false,
      network: 'deny'
    }
  };
}

export function builtInToolProfiles() {
  return {
    [NATIVE_COMPILER_DIAGNOSTIC_PROFILE]: nativeCompilerDiagnosticProfile(),
    [TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE]: transientRecoveryDiagnosticProfile(),
    [CHAT_C_PROJECT_DIAGNOSTIC_PROFILE]: chatCProjectDiagnosticProfile()
  };
}
