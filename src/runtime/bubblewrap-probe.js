import { spawn } from 'node:child_process';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

export const BUBBLEWRAP_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const [projectDir, scratchDir, outsideRead, outsideWrite, stateRead] = process.argv.slice(1);
function canRead(target) { try { fs.readFileSync(target); return true; } catch { return false; } }
function canWrite(target, value = 'mutated') { try { fs.writeFileSync(target, value); return true; } catch { return false; } }
function effectiveCapabilities() {
  try {
    const match = /^CapEff:\s+([0-9a-fA-F]+)$/mu.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
function canConnect() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '1.1.1.1', port: 53 });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });
}
(async () => {
  const result = {
    projectWrite: canWrite(path.join(projectDir, 'sandbox-project-write.txt'), 'project-ok'),
    scratchWrite: canWrite(path.join(scratchDir, 'sandbox-scratch-write.txt'), 'scratch-ok'),
    outsideRead: canRead(outsideRead),
    outsideWrite: canWrite(outsideWrite),
    stateRead: canRead(stateRead),
    gitWrite: canWrite(path.join(projectDir, '.git', 'config')),
    networkEgress: await canConnect(),
    effectiveCapabilities: effectiveCapabilities(),
  };
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
});
`;

export async function captureSandboxProbeProcess(
  executable,
  args,
  {
    cwd = '/',
    env = {},
    timeoutMs = PROBE_TIMEOUT_MS,
    extraStdio = [],
    release = null,
  } = {},
) {
  if (!Array.isArray(extraStdio)) throw new TypeError('sandbox probe extraStdio must be an array');
  let child;
  try {
    child = spawn(executable, args, containedSpawnOptions({
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', ...extraStdio],
    }));
  } catch (error) {
    if (typeof release === 'function') await release();
    throw error;
  }
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  const append = (current, chunk) => {
    const combined = Buffer.concat([current, Buffer.from(chunk)]);
    if (combined.length <= PROBE_OUTPUT_LIMIT) return combined;
    truncated = true;
    return combined.subarray(combined.length - PROBE_OUTPUT_LIMIT);
  };
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
  let timedOut = false;
  let termination = null;
  const timer = setTimeout(() => {
    timedOut = true;
    termination = terminateProcessTree(child);
  }, timeoutMs);
  timer.unref?.();
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(async () => {
    clearTimeout(timer);
    if (termination) await termination;
    if (typeof release === 'function') await release();
  });
  return {
    ...exit,
    timedOut,
    truncated,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
  };
}
