import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activityLeaseHolderReadyLine } from '../src/runtime/activity-lease-protocol.js';

const holder = fileURLToPath(new URL('../src/entry/activity-lease-holder.mjs', import.meta.url));

function closeOf(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function firstLine(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder readiness timed out')), 5_000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      resolve(output);
    });
    child.once('error', reject);
  });
}

test('path-free holder remains alive until its standard input closes', async () => {
  const child = spawn(process.execPath, [holder], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const closed = closeOf(child);
  assert.equal(await firstLine(child), activityLeaseHolderReadyLine());
  const early = await Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 40))]);
  assert.equal(early, false);
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
});

test('holder rejects arguments and never emits readiness', async () => {
  const child = spawn(process.execPath, [holder, '/foreign'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  assert.deepEqual(await closeOf(child), { code: 64, signal: null });
  assert.equal(stdout, '');
});
