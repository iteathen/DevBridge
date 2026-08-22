import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControllerInputRegistry } from '../src/run/controller-input-registry.js';

function scratchAt(root) {
  return {
    async directory(id) {
      const target = path.join(root, id);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(target, { recursive: true });
      return target;
    },
  };
}

test('controller input materialization binds local source identity, bytes, destination, and exact readback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-input-'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-input-scratch-'));
  let guards = 0;
  try {
    const registry = new ControllerInputRegistry({ effectGuard: async () => { guards += 1; } });
    registry.register('fixture.one', {
      destination: 'test/fixtures/input.bundle',
      async load() { return { bytes: Buffer.from([0, 1, 2, 255]), subject: 'subject-one' }; },
    });

    const first = await registry.materialize('fixture.one', { projectDir: root, scratch: scratchAt(scratch) });
    assert.equal(first.subject, 'subject-one');
    assert.equal(first.bytes, 4);
    assert.match(first.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(first.reconciled, false);
    assert.deepEqual(await readFile(path.join(root, 'test', 'fixtures', 'input.bundle')), Buffer.from([0, 1, 2, 255]));

    const second = await registry.materialize('fixture.one', { projectDir: root, scratch: scratchAt(scratch) });
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.reconciled, true);
    assert.ok(guards >= 4);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test('controller inputs cannot overwrite divergent files or select unregistered local authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-input-reject-'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-input-reject-scratch-'));
  try {
    const registry = new ControllerInputRegistry();
    registry.register('fixture.one', {
      destination: 'test/fixtures/input.bundle',
      async load() { return { bytes: Buffer.from('expected'), subject: 'subject-one' }; },
    });
    await assert.rejects(() => registry.materialize('fixture.missing', { projectDir: root, scratch: scratchAt(scratch) }), /not locally registered/u);

    const destination = path.join(root, 'test', 'fixtures');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'input.bundle'), 'different', 'utf8');
    await assert.rejects(() => registry.materialize('fixture.one', { projectDir: root, scratch: scratchAt(scratch) }), /different content/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
