import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeCudaBackendInventory } from '../src/runtime/accelerators/windows-native-cuda-backend-inventory.js';

function fakeResolver({ runtime = 'C:\\Windows\\System32\\nvcuda.dll', accelerator = 'C:\\Windows\\System32\\nvidia-smi.exe' } = {}) {
  return async (kind) => kind === 'runtime' ? runtime : accelerator;
}

function fakeInvoke(responses, calls) {
  return async (request) => {
    calls.push(request);
    const key = request.arguments.join(' ');
    const response = responses[key];
    if (response instanceof Error) throw response;
    return response ?? { exitCode: 1, stdout: '', stderr: 'missing fake response' };
  };
}

const ok = (stdout = '') => ({ exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' });
const fail = (stderr = 'failed') => ({ exitCode: 1, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr });
const gpuQuery = '--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits';

function goodResponses() {
  return { [gpuQuery]: ok('7.5, 581.80') };
}

test('native Windows driver substrate is an independent candidate without an auxiliary environment', async () => {
  const calls = [];
  const inventory = new WindowsNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveLocal: fakeResolver(), platform: 'win32', arch: 'x64', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.disposition, 'candidate');
  assert.equal(result.api, 'cuda');
  assert.equal(result.topology, 'host-retained');
  assert.deepEqual(result.checks.hostPlatform, { state: 'ready', reason: null });
  assert.deepEqual(result.checks.backendRuntime, { state: 'ready', reason: null });
  assert.deepEqual(result.checks.backendEnvironment, { state: 'ready', reason: null });
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'ready', reason: null });
  assert.deepEqual(result.checks.boundaryTransport, { state: 'unknown', reason: 'transport-unproven' });
  assert.deepEqual(result.checks.securityBoundary, { state: 'unknown', reason: 'security-unproven' });
  assert.equal(calls.length, 1);
});

test('missing native driver library is an explicit runtime blocker but does not invent an environment blocker', async () => {
  const calls = [];
  const inventory = new WindowsNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveLocal: fakeResolver({ runtime: null }), platform: 'win32', arch: 'x64', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.disposition, 'blocked');
  assert.deepEqual(result.checks.backendRuntime, { state: 'blocked', reason: 'runtime-unavailable' });
  assert.deepEqual(result.checks.backendEnvironment, { state: 'ready', reason: null });
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'ready', reason: null });
});

test('missing GPU observation helper remains unknown rather than claiming accelerator absence', async () => {
  const inventory = new WindowsNativeCudaBackendInventory({
    invoke: async () => ok(), resolveLocal: fakeResolver({ accelerator: null }), platform: 'win32', arch: 'x64', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.disposition, 'unknown');
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'unknown', reason: 'accelerator-observation-failed' });
});

test('failed or malformed GPU observation remains unknown', async () => {
  for (const response of [fail('query failed'), ok('not,a,valid,row')]) {
    const calls = [];
    const inventory = new WindowsNativeCudaBackendInventory({
      invoke: fakeInvoke({ [gpuQuery]: response }, calls), resolveLocal: fakeResolver(), platform: 'win32', arch: 'x64', release: '10.0.26200', env: {},
    });
    const result = await inventory.observe();
    assert.deepEqual(result.checks.acceleratorRuntime, { state: 'unknown', reason: 'accelerator-observation-failed' });
  }
});

test('invalid zero compute capability is blocked explicitly', async () => {
  const calls = [];
  const inventory = new WindowsNativeCudaBackendInventory({
    invoke: fakeInvoke({ [gpuQuery]: ok('0.0, 581.80') }, calls), resolveLocal: fakeResolver(), platform: 'win32', arch: 'x64', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'blocked', reason: 'accelerator-incompatible' });
});

test('unsupported platform or architecture blocks without resolving or invoking local resources', async () => {
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'arm64']]) {
    let invoked = 0;
    let resolved = 0;
    const inventory = new WindowsNativeCudaBackendInventory({
      invoke: async () => { invoked += 1; return ok(); },
      resolveLocal: async () => { resolved += 1; return null; },
      platform, arch, release: '10.0.26200', env: {},
    });
    const result = await inventory.observe();
    assert.deepEqual(result.checks.hostPlatform, { state: 'blocked', reason: 'platform-unsupported' });
    assert.equal(result.disposition, 'blocked');
    assert.equal(invoked, 0);
    assert.equal(resolved, 0);
  }
});

test('neutral observation projects no native Windows, vendor, library, executable, or GPU identity', async () => {
  const calls = [];
  const inventory = new WindowsNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls),
    resolveLocal: fakeResolver({ runtime: 'C:\\Sensitive\\nvcuda.dll', accelerator: 'C:\\Sensitive\\nvidia-smi.exe' }),
    platform: 'win32', arch: 'x64', release: '10.0.26200', env: {},
  });
  const text = JSON.stringify(await inventory.observe()).toLowerCase();
  for (const forbidden of ['sensitive', 'nvcuda', 'nvidia', 'windows', 'system32', 'wsl', 'powershell', 'pci', 'pnp', 'hyper-v']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});
