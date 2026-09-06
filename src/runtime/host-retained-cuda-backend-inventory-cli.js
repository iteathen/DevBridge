import os from 'node:os';
import { createAcceleratorBackendInventory } from './accelerator-backend-inventory.js';
import { LinuxNativeCudaBackendInventory } from './accelerators/linux-native-cuda-backend-inventory.js';
import { WindowsNativeCudaBackendInventory } from './accelerators/windows-native-cuda-backend-inventory.js';
import { WindowsWslCudaBackendInventory } from './accelerators/windows-wsl-cuda-backend-inventory.js';
import { DeterministicProcessRunner } from './deterministic-process-runner.js';

const WINDOWS_ENVIRONMENT_PASS = Object.freeze([
  'SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramW6432',
  'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP',
]);

function invocation(runner, environmentPass) {
  return ({ executable, arguments: args, timeoutMs, maxOutputBytes }) => runner.run({
    executable,
    args,
    cwd: os.tmpdir(),
    timeoutMs,
    maxOutputBytes,
    environment: { pass: environmentPass, set: {} },
    executionClass: 'control-process',
    operation: 'accelerator.backend.inventory',
  });
}

async function main() {
  const runner = new DeterministicProcessRunner({ processPriority: 'below-normal' });
  let inventories;
  if (process.platform === 'win32') {
    const invoke = invocation(runner, WINDOWS_ENVIRONMENT_PASS);
    inventories = [
      new WindowsNativeCudaBackendInventory({ invoke }),
      new WindowsWslCudaBackendInventory({ invoke }),
    ];
  } else if (process.platform === 'linux') {
    inventories = [new LinuxNativeCudaBackendInventory({ invoke: invocation(runner, []) })];
  } else {
    throw new Error('host-retained CUDA backend inventory is unsupported on this host platform');
  }
  const observations = await Promise.all(inventories.map((inventory) => inventory.observe()));
  process.stdout.write(`${JSON.stringify(createAcceleratorBackendInventory(observations))}\n`);
}

main().catch(() => {
  process.stderr.write('host-retained CUDA backend inventory failed\n');
  process.exitCode = 1;
});
