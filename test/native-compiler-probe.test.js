import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runNativeCompilerProbe } from '../src/runtime/native-compiler-probe.js';
import { nativeCompilerDiagnosticProfile, NATIVE_COMPILER_DIAGNOSTIC_PROFILE } from '../src/runtime/builtin-tool-profiles.js';
import { validateToolProfile } from '../src/runtime/cli-profile.js';

test('built-in native compiler profile is fixed, shell-free, and validates standard Windows environment names', () => {
  const profile = nativeCompilerDiagnosticProfile();
  assert.equal(profile.name, NATIVE_COMPILER_DIAGNOSTIC_PROFILE);
  assert.equal(profile.executable, NATIVE_COMPILER_DIAGNOSTIC_PROFILE);
  assert.deepEqual(profile.args, []);
  assert.equal(path.isAbsolute(profile.executable), false);
  assert.ok(profile.environment.pass.includes('ProgramFiles(x86)'));
  const validated = validateToolProfile(profile.name, profile);
  assert.equal(validated.executable, NATIVE_COMPILER_DIAGNOSTIC_PROFILE);
  assert.equal(validated.sandbox.outsideProjectWrite, false);
  assert.equal(validated.sandbox.network, 'deny');
});

test('native toolchain probe recovers compiler and linker failures in one workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-compiler-'));
  try {
    const result = await runNativeCompilerProbe({ workDir: root, env: process.env });
    if (result.blocker === 'native-compiler-unavailable' && !process.env.CI) {
      t.skip('no native compiler is installed on this developer machine');
      return;
    }
    assert.equal(result.status, 'complete', result.summary);
    const byName = new Map(result.tests.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('native-compiler-discovery')?.available, true);
    assert.equal(byName.get('native-compiler-valid')?.exitCode, 0);
    assert.equal(byName.get('native-compiler-valid')?.objectCreated, true);
    assert.notEqual(byName.get('native-compiler-intentional-error')?.exitCode, 0);
    assert.equal(byName.get('native-compiler-intentional-error')?.diagnosticObserved, true);
    assert.equal(byName.get('native-compiler-repair')?.exitCode, 0);
    assert.equal(byName.get('native-compiler-repair')?.objectCreated, true);

    assert.equal(byName.get('native-linker-valid')?.exitCode, 0);
    assert.equal(byName.get('native-linker-valid')?.executableCreated, true);
    assert.equal(byName.get('native-executable-run')?.exitCode, 17);
    assert.equal(byName.get('native-executable-run')?.markerObserved, true);
    assert.notEqual(byName.get('native-linker-intentional-error')?.exitCode, 0);
    assert.equal(byName.get('native-linker-intentional-error')?.diagnosticObserved, true);
    assert.equal(byName.get('native-linker-repair')?.exitCode, 0);
    assert.equal(byName.get('native-linker-repair')?.executableCreated, true);
    assert.equal(byName.get('native-linker-repair-run')?.exitCode, 17);
    assert.equal(byName.get('native-linker-repair-run')?.markerObserved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
