import { spawn } from 'node:child_process';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bestEffortKill(child, signal) {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export function containedSpawnOptions(options = {}) {
  return {
    ...options,
    detached: process.platform !== 'win32',
    windowsHide: true
  };
}

export async function terminateProcessTree(child, { graceMs = 1500, spawnImpl = spawn } = {}) {
  if (!child?.pid) return;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      let killer;
      try {
        killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        });
      } catch {
        bestEffortKill(child, 'SIGKILL');
        resolve();
        return;
      }
      killer.once('error', () => {
        bestEffortKill(child, 'SIGKILL');
        resolve();
      });
      killer.once('exit', () => resolve());
    });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    bestEffortKill(child, 'SIGTERM');
  }

  await sleep(graceMs);
  if (child.exitCode != null || child.signalCode != null) return;

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    bestEffortKill(child, 'SIGKILL');
  }
}
