import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const neutralUrl = new URL('../src/runtime/accelerator-backend-inventory.js', import.meta.url);
const windowsNativeAdapterUrl = new URL('../src/runtime/accelerators/windows-native-cuda-backend-inventory.js', import.meta.url);
const windowsWslAdapterUrl = new URL('../src/runtime/accelerators/windows-wsl-cuda-backend-inventory.js', import.meta.url);
const windowsSystemTargetsUrl = new URL('../src/runtime/windows-system-targets.js', import.meta.url);
const linuxAdapterUrl = new URL('../src/runtime/accelerators/linux-native-cuda-backend-inventory.js', import.meta.url);
const cliUrl = new URL('../src/runtime/host-retained-cuda-backend-inventory-cli.js', import.meta.url);

test('neutral backend inventory stays provider and transport agnostic and contains no backend selection policy', async () => {
  const source = (await readFile(neutralUrl, 'utf8')).toLowerCase();
  for (const forbidden of ['wsl', 'nvidia', 'gpu-p', 'vfio', 'libvirt', 'hyper-v', 'powershell', 'pci', 'pnp', 'vsock', 'socket']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes('selectedbackend'), false);
  assert.equal(source.includes('preferredbackend'), false);
});

test('native Windows substrate adapter uses closed logical system targets and retains no physical target authority', async () => {
  const source = (await readFile(windowsNativeAdapterUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    'nvcuda.dll',
    'nvidia-smi.exe',
    'wsl.exe',
    'process.env',
    'programfiles',
    'programw6432',
    'windir',
    '--install',
    '--update',
    'rundll32',
    'regsvr32',
    'powershell',
    'cmd.exe',
    'shell: true',
    'shell:true',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes('resolvewindowssystemtarget'), true);
  assert.equal(source.includes('windows_system_target.cuda_driver_library'), true);
  assert.equal(source.includes('windows_system_target.nvidia_smi'), true);
  assert.equal(source.includes('--query-gpu=compute_cap,driver_version'), true);
});

test('Windows WSL substrate adapter uses closed logical system targets and contains observation verbs only', async () => {
  const source = (await readFile(windowsWslAdapterUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    'nvcuda.dll',
    'nvidia-smi.exe',
    'wsl.exe',
    'process.env',
    'programfiles',
    'programw6432',
    'windir',
    '--install',
    '--update',
    '--set-version',
    '--set-default',
    '--unregister',
    '--terminate',
    'enable-windowsoptionalfeature',
    'disable-windowsoptionalfeature',
    'shell: true',
    'shell:true',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes('resolvewindowssystemtarget'), true);
  assert.equal(source.includes('windows_system_target.wsl_runtime'), true);
  assert.equal(source.includes('windows_system_target.nvidia_smi'), true);
});

test('Windows system target resolver exclusively owns the closed physical System32 target mapping', async () => {
  const source = (await readFile(windowsSystemTargetsUrl, 'utf8')).toLowerCase();
  assert.equal(source.includes('globalroot'), true);
  assert.equal(source.includes('system32'), true);
  assert.equal(source.includes('nvcuda.dll'), true);
  assert.equal(source.includes('nvidia-smi.exe'), true);
  assert.equal(source.includes('wsl.exe'), true);
  assert.equal(source.includes('process.env'), false);
  assert.equal(source.includes('programfiles'), false);
  assert.equal(source.includes('programw6432'), false);
  assert.equal(source.includes('windir'), false);
});

test('Linux substrate adapter contains read-only observation verbs and no provider mutation surface', async () => {
  const source = (await readFile(linuxAdapterUrl, 'utf8')).toLowerCase();
  for (const forbidden of ['modprobe', 'rmmod', 'insmod', 'nvidia-smi -pm', '--gpu-reset', 'systemctl', 'apt ', 'dnf ', 'zypper ', 'shell: true', 'shell:true']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("['-p']"), true);
  assert.equal(source.includes('--query-gpu=compute_cap,driver_version'), true);
});

test('internal inventory entrypoint has no remote argument surface and observes Windows candidates independently', async () => {
  const source = (await readFile(cliUrl, 'utf8')).toLowerCase();
  assert.equal(source.includes('process.argv'), false);
  assert.equal(source.includes('shell:'), false);
  assert.equal(source.includes('error.message'), false);
  assert.equal(source.includes('error.stack'), false);
  assert.equal(source.includes('windowsnativecudabackendinventory'), true);
  assert.equal(source.includes('windowswslcudabackendinventory'), true);
  assert.equal(source.includes('linuxnativecudabackendinventory'), true);
  assert.equal(source.includes('createacceleratorbackendinventory'), true);
});
