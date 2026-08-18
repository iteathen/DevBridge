import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const NATIVE_COMPILER_DIAGNOSTIC_PROFILE = 'patch-poller-native-compiler';

const NATIVE_COMPILER_CLI = fileURLToPath(new URL('./native-compiler-probe-cli.js', import.meta.url));

export function nativeCompilerDiagnosticProfile() {
  return {
    name: NATIVE_COMPILER_DIAGNOSTIC_PROFILE,
    executable: process.execPath,
    args: [NATIVE_COMPILER_CLI],
    inputMode: 'stdin-json',
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
    environment: {
      pass: [
        'PATH', 'Path', 'PATHEXT',
        'SYSTEMROOT', 'WINDIR', 'SystemDrive',
        'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
        'TEMP', 'TMP', 'TMPDIR'
      ],
      set: {}
    },
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
