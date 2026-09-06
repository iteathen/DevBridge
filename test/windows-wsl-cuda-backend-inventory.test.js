import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsWslCudaBackendInventory } from '../src/runtime/accelerators/windows-wsl-cuda-backend-inventory.js';

function fakeResolver({ runtime = 'C:\\Windows\\System32\\wsl.exe', accelerator = 'C:\\Windows\\System32\\nvidia-smi.exe' } = {}) {
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
const fail = (stderr = 'failed', exitCode = 1) => ({ exitCode, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr });

function goodResponses(listOutput = '  NAME      STATE           VERSION\n* Ubuntu    Running         2') {
  return {
    '--status': ok('Default Version: 2'),
    '--version': ok('WSL version: 2.6.1'),
    '--list --verbose': ok(listOutput),
    '--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits': ok('7.5, 581.80'),
  };
}

test('qualifying substrate is a candidate, never a qualified compute capability', async () => {
  const calls = [];
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveExecutable: fakeResolver(), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.disposition, 'candidate');
  assert.equal(result.api, 'cuda');
  assert.equal(result.topology, 'host-retained');
  assert.equal(result.checks.hostPlatform.state, 'ready');
  assert.equal(result.checks.backendRuntime.state, 'ready');
  assert.equal(result.checks.backendEnvironment.state, 'ready');
  assert.equal(result.checks.acceleratorRuntime.state, 'ready');
  assert.deepEqual(result.checks.boundaryTransport, { state: 'unknown', reason: 'transport-unproven' });
  assert.deepEqual(result.checks.securityBoundary, { state: 'unknown', reason: 'security-unproven' });
  assert.equal(calls.length, 4);
});

test('explicit WSL-not-installed response is a blocked prerequisite, not an observation failure', async () => {
  const calls = [];
  const message = "The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.";
  const responses = {
    '--status': fail(message, 50),
    '--version': fail(message, 1),
    '--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits': ok('7.5, 581.80'),
  };
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(responses, calls), resolveExecutable: fakeResolver(), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.disposition, 'blocked');
  assert.deepEqual(result.checks.backendRuntime, { state: 'blocked', reason: 'runtime-unavailable' });
  assert.deepEqual(result.checks.backendEnvironment, { state: 'blocked', reason: 'environment-unavailable' });
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'ready', reason: null });
  assert.equal(calls.some((call) => call.arguments.join(' ') === '--list --verbose'), false);
  assert.equal(JSON.stringify(result).toLowerCase().includes('wsl'), false);
});

test('unclassified WSL command failures remain unknown', async () => {
  const calls = [];
  const responses = {
    '--status': fail('temporary observation failure', 1),
    '--version': fail('temporary observation failure', 1),
    '--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits': ok('7.5, 581.80'),
  };
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(responses, calls), resolveExecutable: fakeResolver(), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.disposition, 'unknown');
  assert.deepEqual(result.checks.backendRuntime, { state: 'unknown', reason: 'runtime-observation-failed' });
  assert.deepEqual(result.checks.backendEnvironment, { state: 'unknown', reason: 'environment-observation-failed' });
});

test('UTF-16-style nul output still recognizes a version-2 environment without leaking its name', async () => {
  const calls = [];
  const encoded = ' \u0000N\u0000A\u0000M\u0000E\u0000 \u0000 \u0000V\u0000E\u0000R\u0000S\u0000I\u0000O\u0000N\u0000\n\u0000*\u0000 \u0000S\u0000e\u0000c\u0000r\u0000e\u0000t\u0000D\u0000i\u0000s\u0000t\u0000r\u0000o\u0000 \u0000 \u00002\u0000';
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(encoded), calls), resolveExecutable: fakeResolver(), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.checks.backendEnvironment.state, 'ready');
  assert.equal(JSON.stringify(result).includes('SecretDistro'), false);
});

test('only version-1 environments block the candidate and no mutation arguments are issued', async () => {
  const calls = [];
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(goodResponses('NAME STATE VERSION\nLegacy Stopped 1'), calls), resolveExecutable: fakeResolver(), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.equal(result.disposition, 'blocked');
  assert.deepEqual(result.checks.backendEnvironment, { state: 'blocked', reason: 'environment-unavailable' });
  const args = calls.flatMap((call) => call.arguments).join(' ');
  for (const forbidden of ['--install', '--update', '--set-version', '--set-default', '--unregister', '--terminate']) {
    assert.equal(args.includes(forbidden), false);
  }
});

test('old accelerator or driver is reported incompatible', async () => {
  const calls = [];
  const responses = goodResponses();
  responses['--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits'] = ok('5.2, 472.12');
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(responses, calls), resolveExecutable: fakeResolver(), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'blocked', reason: 'accelerator-incompatible' });
});

test('missing accelerator observer is an explicit blocked fact', async () => {
  const calls = [];
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveExecutable: fakeResolver({ accelerator: null }), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'blocked', reason: 'accelerator-unavailable' });
});

test('failed accelerator observation remains unknown rather than guessing', async () => {
  const calls = [];
  const responses = goodResponses();
  responses['--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits'] = fail('driver query failed');
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(responses, calls), resolveExecutable: fakeResolver(), platform: 'win32', release: '10.0.26200', env: {},
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'unknown', reason: 'accelerator-observation-failed' });
  assert.equal(result.disposition, 'unknown');
});

test('non-Windows platform blocks without invoking or resolving host executables', async () => {
  let invoked = 0;
  let resolved = 0;
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: async () => { invoked += 1; return ok(); },
    resolveExecutable: async () => { resolved += 1; return null; },
    platform: 'linux', release: '6.8.0', env: {},
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.hostPlatform, { state: 'blocked', reason: 'platform-unsupported' });
  assert.equal(result.disposition, 'blocked');
  assert.equal(invoked, 0);
  assert.equal(resolved, 0);
});

test('neutral observation never projects backend, vendor, environment name, executable path, or raw local identity', async () => {
  const calls = [];
  const inventory = new WindowsWslCudaBackendInventory({
    invoke: fakeInvoke(goodResponses('NAME STATE VERSION\nInternalSecret Running 2'), calls),
    resolveExecutable: fakeResolver({ runtime: 'C:\\Sensitive\\wsl.exe', accelerator: 'C:\\Sensitive\\nvidia-smi.exe' }),
    platform: 'win32', release: '10.0.26200', env: {},
  });
  const text = JSON.stringify(await inventory.observe()).toLowerCase();
  for (const forbidden of ['internalsecret', 'sensitive', 'wsl', 'nvidia', 'windows', 'powershell', 'pci', 'pnp', 'vfio', 'hyper-v']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});
