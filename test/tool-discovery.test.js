import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ToolDiscoveryService } from '../src/runtime/tool-discovery.js';

async function executableFixture(names) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-tool-discovery-'));
  for (const name of names) {
    const file = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    await writeFile(file, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') await chmod(file, 0o755);
  }
  return directory;
}

test('hot-path discovery scans PATH without version subprocesses and prefers richer available tools', async () => {
  const directory = await executableFixture(['rg', 'grep', 'uv', 'pip']);
  const env = process.platform === 'win32'
    ? { PATH: directory, PATHEXT: '.EXE' }
    : { PATH: directory };
  const service = new ToolDiscoveryService({ env, discoveryBudgetMs: 45 });
  const registry = await service.discover();

  assert.equal(registry.protocol, 'patch-poller/tool-registry-v1');
  assert.ok(registry.elapsedMs >= 0);
  assert.equal(registry.budgetMs, 45);
  assert.equal(registry.entries.find((entry) => entry.name === 'rg').available, true);
  assert.equal(registry.entries.find((entry) => entry.name === 'uv').available, true);
  assert.equal(service.chooseCapability('code-search').name, 'rg');
  assert.equal(service.chooseCapability('python-packages').name, 'uv');
});

test('version-health probing is separate from hot discovery and skips broken preferred tools', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-tool-health-'));
  await writeFile(path.join(directory, 'rg'), '#!/bin/sh\necho broken >&2\nexit 2\n');
  await writeFile(path.join(directory, 'grep'), '#!/bin/sh\necho grep-fixture-1.0\nexit 0\n');
  await chmod(path.join(directory, 'rg'), 0o755);
  await chmod(path.join(directory, 'grep'), 0o755);

  const service = new ToolDiscoveryService({ env: { PATH: directory }, discoveryBudgetMs: 45 });
  await service.discover();
  const probed = await service.probeVersions({ names: ['rg', 'grep'], concurrency: 2 });
  assert.equal(probed.entries.find((entry) => entry.name === 'rg').health, 'broken');
  assert.equal(probed.entries.find((entry) => entry.name === 'grep').health, 'healthy');
  assert.equal(service.choose(['rg', 'grep']).name, 'grep');
});
