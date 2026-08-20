import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const REMOVED = [
  'src/runtime/bubblewrap-probe.js',
  'src/runtime/bubblewrap-sandbox.js',
  'src/runtime/deterministic-sandbox.js',
  'src/runtime/sandbox-status.js',
];
const ACTIVE_FILES = [
  'src/app/runtime.js',
  'src/app/doctor.js',
  'src/runtime/process-runner.js',
  'src/runtime/deterministic-process-runner.js',
  'src/runtime/deterministic-operation-security.js',
  'src/runtime/tool-inventory.js',
  'src/runtime/worker-exchange.js',
];

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('legacy host repository-execution provider modules are absent from the active tree', async () => {
  for (const relative of REMOVED) assert.equal(await exists(path.resolve(relative)), false, `${relative} must be removed`);
});

test('generic execution/control files contain no active legacy provider imports or provider-shaped dependency names', async () => {
  const forbidden = /createDeterministicSandboxProvider|BubblewrapSandboxProvider|sandboxProvider|sandboxIpc\s*\(/u;
  for (const relative of ACTIVE_FILES) {
    const text = await readFile(path.resolve(relative), 'utf8');
    assert.doesNotMatch(text, forbidden, `${relative} leaked legacy provider vocabulary`);
  }
});
