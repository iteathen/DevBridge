import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ToolDiscoveryService } from '../src/runtime/tool-discovery.js';

test('typical single-PATH-directory hot discovery median stays under 50 ms', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-tool-discovery-bench-'));
  for (const name of ['rg', 'grep', 'uv', 'pip', 'git', 'gh', 'docker', 'kubectl', 'curl', 'trivy']) {
    const file = path.join(directory, name);
    await writeFile(file, '#!/bin/sh\nexit 0\n');
    await chmod(file, 0o755);
  }

  // Warm filesystem metadata once, then measure the actual no-subprocess path.
  await new ToolDiscoveryService({ env: { PATH: directory }, discoveryBudgetMs: 45 }).discover();
  const samples = [];
  for (let index = 0; index < 9; index += 1) {
    const registry = await new ToolDiscoveryService({ env: { PATH: directory }, discoveryBudgetMs: 45 }).discover();
    samples.push(registry.elapsedMs);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  assert.ok(median < 50, `expected median discovery < 50 ms, observed ${median.toFixed(2)} ms (${samples.map((v) => v.toFixed(2)).join(', ')})`);
});
