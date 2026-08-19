import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  ensureWindowsJobLauncher,
  windowsSandboxJobLauncherExecutablePath,
} from '../src/bootstrap/windows-sandbox-runtime.mjs';
import { windowsCreateProcessCommandLine } from '../src/runtime/windows-processcontainer-sandbox.js';

const exec = promisify(execFile);

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('compiled Windows job launcher preassigns a detached descendant to kill-on-close containment', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows Job Object regression is Windows-only');
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-job-launcher-'));
  const marker = path.join(root, 'escaped.txt');
  try {
    const helper = ensureWindowsJobLauncher({ home: root, env: process.env });
    assert.equal(helper, windowsSandboxJobLauncherExecutablePath(root));
    assert.equal(await exists(helper), true);

    const descendantCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1200); setTimeout(() => {}, 2500);`;
    const rootCode = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { detached: true, stdio: 'ignore' }); child.unref();`;
    const commandLine = windowsCreateProcessCommandLine([process.execPath, '-e', rootCode]);
    const commandLineBase64 = Buffer.from(commandLine, 'utf8').toString('base64');

    const result = await exec(helper, [
      '--executable', process.execPath,
      '--command-line-base64', commandLineBase64,
    ], {
      cwd: root,
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(result.stderr, '');

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    assert.equal(await exists(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
