import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const NATIVE_COMPILER_DIAGNOSTIC_PROFILE = 'devbridge-native-compiler';
export const TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE = 'devbridge-transient-recovery';
export const CHAT_C_PROJECT_DIAGNOSTIC_PROFILE = 'devbridge-chat-c-project';
export const LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE = 'devbridge-lifecycle-roundtrip';

const NATIVE_COMPILER_CLI = fileURLToPath(new URL('./native-compiler-probe-cli.js', import.meta.url));
const TRANSIENT_RECOVERY_CLI = fileURLToPath(new URL('./transient-recovery-probe-cli.js', import.meta.url));
const CHAT_C_PROJECT_CLI = fileURLToPath(new URL('./chat-c-project-probe-cli.js', import.meta.url));
const LIFECYCLE_ROUNDTRIP_CLI = fileURLToPath(new URL('./lifecycle-roundtrip-probe-cli.js', import.meta.url));
const BUILTIN_RUNTIME_ROOT = fileURLToPath(new URL('../', import.meta.url));

const BUILTIN_PROFILE_NAMES = [
  NATIVE_COMPILER_DIAGNOSTIC_PROFILE,
  TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE,
  CHAT_C_PROJECT_DIAGNOSTIC_PROFILE,
  LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE,
];

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

function builtinSandbox({ outsideProjectRead = 'deny' } = {}) {
  return {
    // These CLIs do not create their own sandbox. The declaration therefore
    // remains "none" even though ProcessRunner requires a separately verified
    // outer OS provider before any built-in profile can execute.
    enforcement: 'none',
    outsideProjectRead,
    outsideProjectWrite: false,
    network: 'deny'
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
    sandbox: builtinSandbox({ outsideProjectRead: 'readonly' })
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
    sandbox: builtinSandbox()
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
    sandbox: builtinSandbox({ outsideProjectRead: 'readonly' })
  };
}

export function lifecycleRoundtripDiagnosticProfile() {
  return {
    name: LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE,
    executable: process.execPath,
    args: [LIFECYCLE_ROUNDTRIP_CLI],
    inputMode: 'stdin-json',
    timeoutMs: 60_000,
    maxOutputBytes: 128 * 1024,
    environment: { pass: [], set: {} },
    sandbox: builtinSandbox()
  };
}

export function builtInToolProfiles() {
  return {
    [NATIVE_COMPILER_DIAGNOSTIC_PROFILE]: nativeCompilerDiagnosticProfile(),
    [TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE]: transientRecoveryDiagnosticProfile(),
    [CHAT_C_PROJECT_DIAGNOSTIC_PROFILE]: chatCProjectDiagnosticProfile(),
    [LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE]: lifecycleRoundtripDiagnosticProfile()
  };
}

export function builtInToolReadRoots() {
  return Object.fromEntries(BUILTIN_PROFILE_NAMES.map((name) => [name, [BUILTIN_RUNTIME_ROOT]]));
}
