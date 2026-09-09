import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const agent = fileURLToPath(new URL('../src/guest/resource-agent.mjs', import.meta.url));

test('scratch layout reuses existing legacy work and selects compact roots only for new work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-scratch-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'legacy'), compact = path.join(root, 'compact');
  const choose = async () => JSON.parse((await exec(process.execPath, [agent, 'select-directory', legacy, compact], { windowsHide: true })).stdout);
  assert.deepEqual(await choose(), { selected: 'compact' });
  await mkdir(legacy);
  assert.deepEqual(await choose(), { selected: 'legacy' });
  await mkdir(compact);
  await assert.rejects(choose(), /both resource layouts are present/);
  await rm(legacy, { recursive: true });
  assert.deepEqual(await choose(), { selected: 'compact' });
  await symlink(compact, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(choose(), /not a real directory/);
});
