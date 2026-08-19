import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { ToolOnboardingService } from '../src/runtime/tool-onboarding.js';

test('automatic onboarding refuses a manifest directory inside the controller-writable workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-onboarding-root-'));
  const workspace = path.join(root, 'workspace');
  const nestedManifests = path.join(workspace, 'manifests');
  await mkdir(nestedManifests, { recursive: true });
  try {
    assert.throws(
      () => new ToolOnboardingService({
        operationRegistry: new DeterministicOperationRegistry(),
        processRunner: { run: async () => { throw new Error('must not execute'); } },
        workspaceRoot: workspace,
        manifestDirectory: nestedManifests,
        autoIntegrate: [{ command: 'rg' }],
      }),
      /outside the controller-writable workspace root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
