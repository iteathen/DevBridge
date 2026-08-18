import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BubblewrapSandboxProvider } from '../src/runtime/bubblewrap-sandbox-provider.js';

const linuxTest = process.platform === 'linux' ? test : test.skip;

linuxTest('bubblewrap launch unshares the host, denies inherited network, and binds only locally supplied roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-bwrap-launch-'));
  try {
    const workspace = path.join(root, 'workspace');
    const scratch = path.join(root, 'scratch');
    const control = path.join(root, 'control');
    await Promise.all([mkdir(workspace), mkdir(scratch), mkdir(control)]);
    const provider = new BubblewrapSandboxProvider({
      config: { readRoots: [] },
      protectedRoots: [control],
      executableResolver: async () => process.execPath,
    });
    const launch = await provider.prepareLaunch({
      executable: process.execPath,
      args: ['--version'],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '' },
      sandbox: { writableRoots: [workspace, scratch], readOnlyRoots: [] },
    });
    assert.equal(launch.executable, process.execPath);
    assert.ok(launch.args.includes('--unshare-all'));
    assert.equal(launch.args.includes('--share-net'), false);
    assert.ok(launch.args.includes('--clearenv'));
    assert.ok(launch.args.includes('--bind'));
    assert.ok(launch.args.includes(workspace));
    assert.ok(launch.args.includes(scratch));
    assert.equal(launch.args.includes(control), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

linuxTest('bubblewrap rejects an owned mapping that would expose protected control state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-bwrap-protected-'));
  try {
    const workspace = path.join(root, 'workspace');
    const protectedRoot = path.join(workspace, 'state');
    await mkdir(protectedRoot, { recursive: true });
    const provider = new BubblewrapSandboxProvider({
      protectedRoots: [protectedRoot],
      executableResolver: async () => process.execPath,
    });
    await assert.rejects(() => provider.prepareLaunch({
      executable: process.execPath,
      args: [],
      cwd: workspace,
      env: {},
      sandbox: { writableRoots: [workspace], readOnlyRoots: [] },
    }), /protected control-plane root/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

linuxTest('bubblewrap verification runs a real boundary probe when the provider exists and otherwise stays explicitly unverified', async () => {
  const provider = new BubblewrapSandboxProvider();
  const observed = await provider.verify();
  assert.equal(observed.provider, 'bubblewrap');
  if (observed.verified) {
    assert.equal(observed.filesystem, true);
    assert.equal(observed.network, true);
    assert.equal(observed.workerIdentity, true);
  } else {
    assert.equal(typeof observed.reason, 'string');
    assert.ok(observed.reason.length > 0);
  }
});
