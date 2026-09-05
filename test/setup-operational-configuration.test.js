import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import {
  createSetupOperationalConfiguration,
  SETUP_OPERATIONAL_CONFIGURATION_REQUEST_PROTOCOL,
} from '../src/setup/operational-configuration.js';

function request(targets = ['owner/alpha', 'owner/beta']) {
  return {
    protocol: SETUP_OPERATIONAL_CONFIGURATION_REQUEST_PROTOCOL,
    targets,
    submitters: ['1775584'],
    owners: [...new Set(targets.map((target) => target.split('/')[0].toLowerCase()))],
  };
}

function publisher(home, overrides = {}) {
  return createSetupOperationalConfiguration({ home, validate: validateConfig }, {
    now: () => '2026-08-28T20:00:00.000Z',
    id: () => '11111111-2222-4333-8444-555555555555',
    ...overrides,
  });
}

test('setup publishes one normal multi-target config only with VM execution enabled and model adapters disabled', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'db-operational-config-'));
  try {
    const first = await publisher(home).reconcile(request());
    assert.equal(first.ready, true);
    assert.equal(first.changed, true);
    assert.equal(first.executionEnabled, true);

    const config = validateConfig(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')));
    assert.deepEqual(config.github.queueRepositories, ['owner/alpha', 'owner/beta']);
    assert.deepEqual(config.github.trustedActorIds, ['1775584']);
    assert.deepEqual(config.workspace.allowedOwners, ['owner']);
    assert.deepEqual(config.workspace.baselineChannels, {});
    assert.equal(config.workspace.defaultBaselineChannel, null);
    assert.equal(config.execution.enabled, true);
    assert.equal(config.execution.controllerPlansEnabled, true);
    assert.equal(config.execution.modelAdaptersEnabled, false);
    assert.equal(config.execution.allowUncontainedTools, false);
    assert.equal(config.execution.toolOnboarding.enabled, false);
    assert.equal(config.publication.autoPushTaskBranches, false);

    const repeated = await publisher(home).reconcile(request());
    assert.equal(repeated.ready, true);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.subject, first.subject);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('setup reconfiguration replaces only its exact unchanged managed predecessor', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'db-operational-reconfigure-'));
  try {
    const selected = publisher(home);
    const first = await selected.reconcile(request(['owner/alpha']));
    const changed = await selected.reconcile(request(['owner/alpha', 'second/beta']));
    assert.equal(changed.ready, true);
    assert.equal(changed.changed, true);
    assert.notEqual(changed.subject, first.subject);
    const config = validateConfig(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')));
    assert.deepEqual(config.github.queueRepositories, ['owner/alpha', 'second/beta']);
    assert.deepEqual(config.workspace.allowedOwners, ['owner', 'second']);
    assert.equal(config.execution.modelAdaptersEnabled, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('setup preserves an unmanaged existing config and managed drift', async () => {
  const unmanagedHome = await mkdtemp(path.join(os.tmpdir(), 'db-operational-unmanaged-'));
  const driftHome = await mkdtemp(path.join(os.tmpdir(), 'db-operational-drift-'));
  try {
    const unmanaged = '{"operator":true}\n';
    await writeFile(path.join(unmanagedHome, 'config.json'), unmanaged, 'utf8');
    await assert.rejects(publisher(unmanagedHome).reconcile(request()), /unmanaged operational configuration/u);
    assert.equal(await readFile(path.join(unmanagedHome, 'config.json'), 'utf8'), unmanaged);

    await publisher(driftHome).reconcile(request());
    const file = path.join(driftHome, 'config.json');
    const drifted = JSON.parse(await readFile(file, 'utf8'));
    drifted.execution.enabled = false;
    const bytes = `${JSON.stringify(drifted, null, 2)}\n`;
    await writeFile(file, bytes, 'utf8');
    await assert.rejects(publisher(driftHome).reconcile(request()), /identity drifted/u);
    assert.equal(await readFile(file, 'utf8'), bytes);
  } finally {
    await rm(unmanagedHome, { recursive: true, force: true });
    await rm(driftHome, { recursive: true, force: true });
  }
});

for (const interruptedPhase of ['planned', 'effect']) {
  test(`setup reconciles an interruption after the ${interruptedPhase} frontier without widening authority`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), `db-operational-${interruptedPhase}-`));
    try {
      let injected = false;
      const fault = async (phase) => {
        if (!injected && phase === interruptedPhase) {
          injected = true;
          throw new Error(`injected ${phase} interruption`);
        }
      };
      await assert.rejects(publisher(home, { fault }).reconcile(request()), new RegExp(`injected ${interruptedPhase}`, 'u'));
      const recovered = await publisher(home).reconcile(request());
      assert.equal(recovered.ready, true);
      const config = validateConfig(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')));
      assert.equal(config.execution.enabled, true);
      assert.equal(config.execution.modelAdaptersEnabled, false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test('setup rejects bounded-record substitution and filesystem indirection', async (t) => {
  const oversizedHome = await mkdtemp(path.join(os.tmpdir(), 'db-operational-oversized-'));
  const linkedHome = await mkdtemp(path.join(os.tmpdir(), 'db-operational-linked-'));
  try {
    await publisher(oversizedHome).reconcile(request());
    const record = path.join(oversizedHome, 'state', 'setup-operational-configuration', 'state.json');
    await writeFile(record, 'x'.repeat(1024 * 1024 + 1), 'utf8');
    await assert.rejects(publisher(oversizedHome).reconcile(request()), /one bounded real file/u);

    const outside = path.join(linkedHome, 'outside.json');
    await writeFile(outside, '{}\n', 'utf8');
    const config = path.join(linkedHome, 'config.json');
    try { await symlink(outside, config, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`symlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(publisher(linkedHome).reconcile(request()), /one bounded real file/u);
  } finally {
    await rm(oversizedHome, { recursive: true, force: true });
    await rm(linkedHome, { recursive: true, force: true });
  }
});

test('operational configuration owner contains no provider, guest, bridge, or repository execution topology', async () => {
  const source = await readFile(new URL('../src/setup/operational-configuration.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Hyper-?V|WinNAT|libvirt|QEMU|VHDX|qcow2|guest credential|bridge endpoint|VMName/iu);
});
