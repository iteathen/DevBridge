export const NATIVE_COMPILER_DIAGNOSTIC_PROFILE = 'devbridge-native-compiler';
export const TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE = 'devbridge-transient-recovery';
export const CHAT_C_PROJECT_DIAGNOSTIC_PROFILE = 'devbridge-chat-c-project';
export const LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE = 'devbridge-lifecycle-roundtrip';

function windowsToolchainEnvironment() {
  return {
    pass: [
      'PATH', 'Path', 'PATHEXT',
      'SYSTEMROOT', 'WINDIR', 'SystemDrive',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'TEMP', 'TMP', 'TMPDIR',
    ],
    set: {},
  };
}

function isolationPolicy({ outsideProjectRead = 'deny' } = {}) {
  return {
    enforcement: 'none',
    outsideProjectRead,
    outsideProjectWrite: false,
    network: 'deny',
  };
}

export function nativeCompilerDiagnosticProfile() {
  return {
    name: NATIVE_COMPILER_DIAGNOSTIC_PROFILE,
    executable: NATIVE_COMPILER_DIAGNOSTIC_PROFILE,
    args: [],
    inputMode: 'stdin-json',
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
    environment: windowsToolchainEnvironment(),
    sandbox: isolationPolicy({ outsideProjectRead: 'readonly' }),
  };
}

export function transientRecoveryDiagnosticProfile() {
  return {
    name: TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE,
    executable: TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE,
    args: [],
    inputMode: 'stdin-json',
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    environment: { pass: [], set: {} },
    sandbox: isolationPolicy(),
  };
}

export function chatCProjectDiagnosticProfile() {
  return {
    name: CHAT_C_PROJECT_DIAGNOSTIC_PROFILE,
    executable: CHAT_C_PROJECT_DIAGNOSTIC_PROFILE,
    args: [],
    inputMode: 'stdin-json',
    timeoutMs: 180_000,
    maxOutputBytes: 512 * 1024,
    environment: windowsToolchainEnvironment(),
    sandbox: isolationPolicy({ outsideProjectRead: 'readonly' }),
  };
}

export function lifecycleRoundtripDiagnosticProfile() {
  return {
    name: LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE,
    executable: LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE,
    args: [],
    inputMode: 'stdin-json',
    timeoutMs: 60_000,
    maxOutputBytes: 128 * 1024,
    environment: { pass: [], set: {} },
    sandbox: isolationPolicy(),
  };
}

export function builtInToolProfiles() {
  return {
    [NATIVE_COMPILER_DIAGNOSTIC_PROFILE]: nativeCompilerDiagnosticProfile(),
    [TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE]: transientRecoveryDiagnosticProfile(),
    [CHAT_C_PROJECT_DIAGNOSTIC_PROFILE]: chatCProjectDiagnosticProfile(),
    [LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE]: lifecycleRoundtripDiagnosticProfile(),
  };
}
