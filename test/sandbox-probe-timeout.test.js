import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSandboxProbeTimeoutMs } from '../src/runtime/bubblewrap-probe.js';

test('Windows ProcessContainer wrapper probe deadline covers DACL fallback cleanup', () => {
  assert.equal(effectiveSandboxProbeTimeoutMs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 40_000, 'win32'), 90_000);
  assert.equal(effectiveSandboxProbeTimeoutMs('C:\\tools\\wxc-exec.exe', 40_000, 'win32'), 40_000);
  assert.equal(effectiveSandboxProbeTimeoutMs('/usr/bin/powershell.exe', 40_000, 'linux'), 40_000);
});
