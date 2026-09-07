import { access } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { SetupAuthorityManager } from '../../src/runtime/setup-authority.js';
import { createSetupAuthorityStateStore } from '../../src/state/setup-authority-state-store.js';

const [mode, target, identity, signal] = process.argv.slice(2);

async function waitForSignal(file) {
  for (;;) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await pause(5);
    }
  }
}

if (mode != null) {
  try {
    const port = createSetupAuthorityStateStore(target);
    if (mode === 'begin') {
      process.stdout.write('ready\n');
      await waitForSignal(signal);
      const manager = new SetupAuthorityManager({ port, id: () => identity });
      process.stdout.write(`${JSON.stringify(await manager.begin())}\n`);
    } else if (mode === 'hold') {
      await port.mutate(async () => {
        process.stdout.write('ready\n');
        await new Promise(() => {});
      });
    } else {
      throw new Error('fixture mode is invalid');
    }
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
