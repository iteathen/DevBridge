import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';
import { PersistentPlanVerifyingExecutor, verifyPersistentPlanFiles } from '../src/run/persistent-plan-verifier.js';

function plan(files) {
  return normalizeControllerPlan({
    protocol: 'patch-poller/controller-plan-v1',
    files,
    operations: [],
    assertions: [],
  });
}

async function makeRoot(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  await mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

test('final persistent-byte verification accepts exact plan bytes', async () => {
  const root = await makeRoot('pp-final-bytes-ok-');
  try {
    const controllerPlan = plan([{ action: 'create', path: 'src/value.mjs', content: 'export const value = 1;\n' }]);
    await writeFile(path.join(root, 'src', 'value.mjs'), 'export const value = 1;\n');
    const evidence = await verifyPersistentPlanFiles(controllerPlan, root);
    assert.equal(evidence[0].state, 'verified-exact');
    assert.equal(evidence[0].sha256, controllerPlan.files[0].contentSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('final persistent-byte verification rejects a planned file mutated after execution', async () => {
  const root = await makeRoot('pp-final-bytes-mutate-');
  try {
    const controllerPlan = plan([{ action: 'create', path: 'src/value.mjs', content: 'export const value = 1;\n' }]);
    await writeFile(path.join(root, 'src', 'value.mjs'), 'export const value = 999;\n');
    await assert.rejects(() => verifyPersistentPlanFiles(controllerPlan, root), /SHA-256 changed after execution/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('final persistent-byte verification rejects recreation of a planned delete', async () => {
  const root = await makeRoot('pp-final-bytes-delete-');
  try {
    const original = 'delete me\n';
    const crypto = await import('node:crypto');
    const expectedSha256 = crypto.createHash('sha256').update(original).digest('hex');
    const controllerPlan = plan([{ action: 'delete', path: 'src/old.txt', expectedSha256 }]);
    await writeFile(path.join(root, 'src', 'old.txt'), 'recreated\n');
    await assert.rejects(() => verifyPersistentPlanFiles(controllerPlan, root), /was recreated after execution/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifying executor records rejection before candidate sealing can continue', async () => {
  const root = await makeRoot('pp-final-bytes-decorator-');
  try {
    const controllerPlan = plan([{ action: 'create', path: 'src/value.mjs', content: 'expected\n' }]);
    const state = { controllerPlan: { phase: 'complete' } };
    const delegate = {
      async execute() {
        await writeFile(path.join(root, 'src', 'value.mjs'), 'tampered\n');
        return { summary: 'delegate complete', tests: [], snapshot: {} };
      },
    };
    const executor = new PersistentPlanVerifyingExecutor({ delegate });
    let persists = 0;
    await assert.rejects(() => executor.execute({
      plan: controllerPlan,
      state,
      workspace: { worktreeDir: root },
      persist: async () => { persists += 1; },
    }), /SHA-256 changed after execution/u);
    assert.equal(state.controllerPlan.phase, 'final-byte-rejected');
    assert.equal(state.controllerPlan.finalFileVerification.state, 'rejected');
    assert.ok(persists >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
