import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureWindowsLifecycleAuthorityCandidate } from '../src/setup/windows-lifecycle-authority-service.js';

const SERVICE_SOURCE = fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-service.js', import.meta.url));

async function runtimeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-authority-runtime-evidence-'));
  const packageRoot = path.join(root, 'package');
  const nodeExecutable = path.join(root, 'node.exe');
  await mkdir(path.join(packageRoot, 'src'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), '{"name":"devbridge-fixture","version":"1.0.0"}\n');
  await writeFile(path.join(packageRoot, 'src', 'entry.js'), 'export const value = 1;\n');
  await writeFile(nodeExecutable, 'node-runtime-a\n');
  return { root, packageRoot, nodeExecutable };
}

test('runtime evidence changes when protected package source changes', async () => {
  const fixture = await runtimeFixture();
  try {
    const first = await measureWindowsLifecycleAuthorityCandidate(fixture);
    await writeFile(path.join(fixture.packageRoot, 'src', 'entry.js'), 'export const value = 2;\n');
    const second = await measureWindowsLifecycleAuthorityCandidate(fixture);
    assert.notEqual(second.evidence.packageDigest, first.evidence.packageDigest);
    assert.equal(second.evidence.nodeDigest, first.evidence.nodeDigest);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runtime evidence changes when the Node executable changes', async () => {
  const fixture = await runtimeFixture();
  try {
    const first = await measureWindowsLifecycleAuthorityCandidate(fixture);
    await writeFile(fixture.nodeExecutable, 'node-runtime-b\n');
    const second = await measureWindowsLifecycleAuthorityCandidate(fixture);
    assert.equal(second.evidence.packageDigest, first.evidence.packageDigest);
    assert.notEqual(second.evidence.nodeDigest, first.evidence.nodeDigest);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('SCM runtime evidence is both configured and observed by the Windows service owner', async () => {
  const source = await readFile(SERVICE_SOURCE, 'utf8');
  assert.match(source, /\['description', plan\.service\.name, plan\.service\.description\]/u);
  assert.match(source, /service\.description === plan\.service\.description/u);
  assert.match(source, /Windows lifecycle authority runtime evidence configuration/u);
  assert.doesNotMatch(source, /Set-Service/u);
});
