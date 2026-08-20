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
const NEUTRAL_FILES = [
  'src/app/runtime.js',
  'src/app/doctor.js',
  'src/bootstrap/secure-bootstrap.mjs',
  'src/runtime/repository-execution.js',
  'src/runtime/process-runner.js',
  'src/runtime/deterministic-process-runner.js',
  'src/runtime/deterministic-operation-security.js',
  'src/runtime/tool-inventory.js',
  'src/runtime/worker-exchange.js',
  'src/runtime/local-operation-manifest.js',
  'src/runtime/tool-onboarding.js',
];

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('legacy host repository-execution provider modules are absent from the active tree', async () => {
  for (const relative of REMOVED) assert.equal(await exists(path.resolve(relative)), false, `${relative} must be removed`);
});

test('neutral execution/control files contain no active legacy provider imports or provider-shaped dependency names', async () => {
  const forbidden = /createDeterministicSandboxProvider|BubblewrapSandboxProvider|bubblewrap|processcontainer|appcontainer|sandboxProvider|sandboxIpc\s*\(|sandboxValidateRuntimeCandidate|validationSandbox/iu;
  for (const relative of NEUTRAL_FILES) {
    const text = await readFile(path.resolve(relative), 'utf8');
    assert.doesNotMatch(text, forbidden, `${relative} leaked legacy provider vocabulary`);
  }
});

test('repository-operation compatibility adapters cannot resolve or inject host execution mechanics', async () => {
  const localManifest = await readFile(path.resolve('src/runtime/local-operation-manifest.js'), 'utf8');
  assert.doesNotMatch(localManifest, /resolveExecutable|sandbox\s*:/u);
  assert.match(localManifest, /repositoryTool/u);

  const onboarding = await readFile(path.resolve('src/runtime/tool-onboarding.js'), 'utf8');
  assert.doesNotMatch(onboarding, /resolveExecutable|processRunner|sandbox\s*:/u);
  assert.match(onboarding, /repository-execution-unavailable/u);
});
