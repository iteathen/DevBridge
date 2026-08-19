import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { windowsCreateProcessCommandLine } from '../src/runtime/windows-processcontainer-sandbox.js';

const exec = promisify(execFile);
const wrapper = fileURLToPath(new URL('../src/runtime/windows-job-wrapper.ps1', import.meta.url));

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function systemPowerShell() {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

test('Windows outer kill-on-close job terminates a detached descendant when the root exits', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows Job Object regression is Windows-only');
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-job-wrapper-'));
  const marker = path.join(root, 'escaped.txt');
  try {
    const descendantCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1200); setTimeout(() => {}, 2500);`;
    const rootCode = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { detached: true, stdio: 'ignore' }); child.unref();`;
    const argumentsText = windowsCreateProcessCommandLine(['-e', rootCode]);
    const argumentsBase64 = Buffer.from(argumentsText, 'utf8').toString('base64');

    const { stderr } = await exec(systemPowerShell(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', wrapper,
      '-Executable', process.execPath,
      '-ArgumentsBase64', argumentsBase64,
    ], { cwd: root, windowsHide: true, timeout: 15_000 });
    assert.equal(stderr, '');

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    assert.equal(await exists(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
