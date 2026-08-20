import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentFoundation } from '../src/app/environment-foundation.js';

test('composition persists one local identity and unsupported topology remains explicit and provider-neutral', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-compose-'));
  try {
    const first = await createEnvironmentFoundation({ stateDirectory: root, platform: 'unsupported-fixture' });
    const second = await createEnvironmentFoundation({ stateDirectory: root, platform: 'unsupported-fixture' });
    const a = await first.inspect();
    const b = await second.inspect();
    assert.equal(a.identity, b.identity);
    assert.equal(a.ready, false);
    assert.equal(a.capabilities.management.ready, false);
    assert.equal(a.capabilities.images.ready, false);
    const serialized = JSON.stringify(a).toLowerCase();
    for (const foreign of ['hyper-v', 'hyperv', 'libvirt', 'qemu', 'powershell', 'virsh']) assert.equal(serialized.includes(foreign), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
