import test from 'node:test';
import assert from 'node:assert/strict';
import { LinuxNativeCudaBackendInventory } from '../src/runtime/accelerators/linux-native-cuda-backend-inventory.js';

function fakeResolver({ loader = '/usr/sbin/ldconfig', accelerator = '/usr/bin/nvidia-smi' } = {}) {
  return async (kind) => kind === 'loader' ? loader : accelerator;
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
const devicesReady = async () => ({ observed: true, controlReady: true, deviceCount: 1 });

function goodResponses() {
  return {
    '-p': ok('123 libs found in cache `/etc/ld.so.cache`\n\tlibcuda.so.1 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libcuda.so.1'),
    '--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits': ok('7.5, 581.80'),
  };
}

test('qualifying Linux native substrate is a candidate, never a qualified compute capability', async () => {
  const calls = [];
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls),
    resolveExecutable: fakeResolver(),
    observeDeviceAccess: devicesReady,
    platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 1000,
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
  assert.equal(calls.length, 2);
});

test('missing CUDA driver library blocks the backend runtime without guessing', async () => {
  const calls = [];
  const responses = goodResponses();
  responses['-p'] = ok('42 libs found in cache\n\tlibm.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libm.so.6');
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(responses, calls), resolveExecutable: fakeResolver(), observeDeviceAccess: devicesReady,
    platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 1000,
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.backendRuntime, { state: 'blocked', reason: 'runtime-unavailable' });
  assert.equal(result.disposition, 'blocked');
});

test('missing loader observer leaves runtime unknown instead of declaring CUDA absent', async () => {
  const calls = [];
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveExecutable: fakeResolver({ loader: null }), observeDeviceAccess: devicesReady,
    platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 1000,
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.backendRuntime, { state: 'unknown', reason: 'runtime-observation-failed' });
  assert.equal(result.disposition, 'unknown');
});

test('inaccessible accelerator device nodes block the backend environment', async () => {
  const calls = [];
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveExecutable: fakeResolver(),
    observeDeviceAccess: async () => ({ observed: true, controlReady: false, deviceCount: 0 }),
    platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 1000,
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.backendEnvironment, { state: 'blocked', reason: 'environment-unavailable' });
});

test('elevated Linux inventory refuses nvidia-smi so the read-only claim remains truthful', async () => {
  const calls = [];
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveExecutable: fakeResolver(), observeDeviceAccess: devicesReady,
    platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 0,
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'unknown', reason: 'accelerator-observation-failed' });
  assert.equal(result.disposition, 'unknown');
  assert.deepEqual(calls.map((call) => call.arguments), [['-p']]);
});

test('failed accelerator observation remains unknown rather than guessing', async () => {
  const calls = [];
  const responses = goodResponses();
  responses['--query-gpu=compute_cap,driver_version --format=csv,noheader,nounits'] = fail('driver query failed');
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(responses, calls), resolveExecutable: fakeResolver(), observeDeviceAccess: devicesReady,
    platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 1000,
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'unknown', reason: 'accelerator-observation-failed' });
  assert.equal(result.disposition, 'unknown');
});

test('missing accelerator observer leaves accelerator readiness unknown instead of declaring hardware absent', async () => {
  const calls = [];
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls), resolveExecutable: fakeResolver({ accelerator: null }), observeDeviceAccess: devicesReady,
    platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 1000,
  });
  const result = await inventory.observe();
  assert.deepEqual(result.checks.acceleratorRuntime, { state: 'unknown', reason: 'accelerator-observation-failed' });
  assert.equal(result.disposition, 'unknown');
});

test('non-Linux or unsupported architecture blocks before host observation', async () => {
  for (const sample of [
    { platform: 'win32', architecture: 'x64' },
    { platform: 'linux', architecture: 'riscv64' },
  ]) {
    let invoked = 0;
    let resolved = 0;
    let deviceObserved = 0;
    const inventory = new LinuxNativeCudaBackendInventory({
      invoke: async () => { invoked += 1; return ok(); },
      resolveExecutable: async () => { resolved += 1; return null; },
      observeDeviceAccess: async () => { deviceObserved += 1; return { observed: true, controlReady: true, deviceCount: 1 }; },
      platform: sample.platform, architecture: sample.architecture, release: '6.14.0', effectiveUid: 1000,
    });
    const result = await inventory.observe();
    assert.deepEqual(result.checks.hostPlatform, { state: 'blocked', reason: 'platform-unsupported' });
    assert.equal(result.disposition, 'blocked');
    assert.equal(invoked, 0);
    assert.equal(resolved, 0);
    assert.equal(deviceObserved, 0);
  }
});

test('unrelated loader-cache lines do not change the opaque backend generation', async () => {
  const firstCalls = [];
  const secondCalls = [];
  const first = goodResponses();
  const second = goodResponses();
  second['-p'] = ok('999 libs found in cache\n\tlibsomething.so.9 (libc6,x86-64) => /tmp/irrelevant.so\n\tlibcuda.so.1 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libcuda.so.1');
  const common = { resolveExecutable: fakeResolver(), observeDeviceAccess: devicesReady, platform: 'linux', architecture: 'x64', release: '6.14.0', effectiveUid: 1000 };
  const left = await new LinuxNativeCudaBackendInventory({ ...common, invoke: fakeInvoke(first, firstCalls) }).observe();
  const right = await new LinuxNativeCudaBackendInventory({ ...common, invoke: fakeInvoke(second, secondCalls) }).observe();
  assert.equal(left.generation, right.generation);
});

test('Linux adapter projects no provider, path, device, or raw driver identity and has no mutation argv', async () => {
  const calls = [];
  const inventory = new LinuxNativeCudaBackendInventory({
    invoke: fakeInvoke(goodResponses(), calls),
    resolveExecutable: fakeResolver({ loader: '/usr/sbin/ldconfig', accelerator: '/usr/bin/nvidia-smi' }),
    observeDeviceAccess: devicesReady,
    platform: 'linux', architecture: 'x64', release: '6.14.0-secret', effectiveUid: 1000,
  });
  const text = JSON.stringify(await inventory.observe()).toLowerCase();
  for (const forbidden of ['nvidia', 'libcuda', '/usr/', '/dev/', 'ldconfig', 'linux', 'vfio', 'libvirt', 'pci']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  const args = calls.flatMap((call) => call.arguments);
  assert.deepEqual(args, ['-p', '--query-gpu=compute_cap,driver_version', '--format=csv,noheader,nounits']);
});
