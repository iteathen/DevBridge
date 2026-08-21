import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireRuntimeSupervisorLock,
  runtimeSupervisorEndpoint,
} from '../src/bootstrap/runtime-supervisor-lock.mjs';

test('supervisor endpoint is home-wide and uses crash-cleaned operating-system namespaces', () => {
  const first = runtimeSupervisorEndpoint('/managed', { platform: 'linux' });
  const alternateConfig = runtimeSupervisorEndpoint('/managed', { platform: 'linux' });
  const otherHome = runtimeSupervisorEndpoint('/managed-other', { platform: 'linux' });
  assert.equal(first, alternateConfig);
  assert.notEqual(first, otherHome);
  assert.equal(first.startsWith('\0devbridge-supervisor-'), true);
  assert.match(runtimeSupervisorEndpoint('C:\\Users\\Example\\.devbridge', { platform: 'win32' }), /^\\\\\.\\pipe\\devbridge-supervisor-[0-9a-f]{40}$/u);
});

test('only one supervisor can own an installation home and release permits clean reacquisition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-supervisor-lock-'));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'devbridge-supervisor-lock-other-'));
  const releaseFirst = await acquireRuntimeSupervisorLock(root);
  const releaseOther = await acquireRuntimeSupervisorLock(otherRoot);
  await assert.rejects(
    acquireRuntimeSupervisorLock(root),
    (error) => error?.code === 'DEVBRIDGE_SUPERVISOR_ACTIVE' && /already owns this installation home/u.test(error.message),
  );
  await releaseFirst();
  const releaseReplacement = await acquireRuntimeSupervisorLock(root);
  await releaseReplacement();
  await releaseReplacement();
  await releaseOther();
});

test('operating system releases supervisor ownership after the owner process is terminated', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-supervisor-crash-'));
  const moduleUrl = new URL('../src/bootstrap/runtime-supervisor-lock.mjs', import.meta.url).href;
  const script = [
    `import { acquireRuntimeSupervisorLock } from ${JSON.stringify(moduleUrl)};`,
    'await acquireRuntimeSupervisorLock(process.argv[1]);',
    "process.stdout.write('locked\\n');",
    'await new Promise(() => {});',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  context.after(() => { if (child.exitCode == null) child.kill(); });
  const observed = await Promise.race([
    once(child.stdout, 'data').then(([data]) => data.toString('utf8')),
    once(child, 'exit').then(([code]) => { throw new Error(`lock owner exited before readiness with ${code}`); }),
  ]);
  assert.equal(observed, 'locked\n');
  child.kill();
  await once(child, 'exit');
  const release = await acquireRuntimeSupervisorLock(root);
  await release();
});
