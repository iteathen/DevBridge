import test from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicFaultInjector, FaultInjectionError } from '../src/runtime/fault-injector.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';

test('fault injector is inert unless locally enabled', () => {
  const disabled = new DeterministicFaultInjector({ enabled: false, rules: [{ point: 'operation.before', action: 'error' }] });
  assert.equal(disabled.throwIfTriggered('operation.before', { operation: 'node.test' }), null);
  assert.equal(disabled.inspect().enabled, false);
});

test('fault injector deterministically triggers only the configured occurrence and operation', () => {
  const faults = new DeterministicFaultInjector({
    enabled: true,
    rules: [{ id: 'second-test', point: 'operation.before', action: 'crash', occurrence: 2, operation: 'node.test' }],
  });
  assert.equal(faults.throwIfTriggered('operation.before', { operation: 'node.syntax-check' }), null);
  assert.equal(faults.throwIfTriggered('operation.before', { operation: 'node.test' }), null);
  assert.throws(() => faults.throwIfTriggered('operation.before', { operation: 'node.test' }), (error) => {
    assert.ok(error instanceof FaultInjectionError);
    assert.equal(error.simulatedCrash, true);
    return true;
  });
  assert.equal(faults.throwIfTriggered('operation.before', { operation: 'node.test' }), null);
});

test('process-level timeout and truncation faults modify bounded evidence without changing argv authority', async () => {
  const timeoutFaults = new DeterministicFaultInjector({
    enabled: true,
    rules: [{ point: 'process.after-exit', action: 'timeout', operation: 'fixture' }],
  });
  const timeoutRunner = new DeterministicProcessRunner({ faultInjector: timeoutFaults });
  const timed = await timeoutRunner.run({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('ok')"],
    cwd: process.cwd(),
    environment: { pass: process.platform === 'win32' ? ['SYSTEMROOT', 'WINDIR', 'PATH', 'Path', 'PATHEXT'] : ['PATH', 'HOME'] },
    operation: 'fixture',
  });
  assert.equal(timed.exitCode, 0);
  assert.equal(timed.timedOut, true);

  const truncateFaults = new DeterministicFaultInjector({
    enabled: true,
    rules: [{ point: 'process.after-exit', action: 'truncate-output', operation: 'fixture' }],
  });
  const truncateRunner = new DeterministicProcessRunner({ faultInjector: truncateFaults });
  const truncated = await truncateRunner.run({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('abcdefghijklmnopqrstuvwxyz0123456789')"],
    cwd: process.cwd(),
    environment: { pass: process.platform === 'win32' ? ['SYSTEMROOT', 'WINDIR', 'PATH', 'Path', 'PATHEXT'] : ['PATH', 'HOME'] },
    operation: 'fixture',
  });
  assert.equal(truncated.exitCode, 0);
  assert.equal(truncated.outputTruncated, true);
  assert.ok(Buffer.byteLength(truncated.stdout, 'utf8') <= 32);
  assert.equal(truncated.stdout.endsWith('456789'), true);
});
