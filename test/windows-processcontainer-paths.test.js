import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  canonicalizeWindowsReadRootPath,
  canonicalizeWindowsWorkspacePath,
  createWindowsProcessContainerId,
  windowsProcessContainerProbeTimeouts,
} from '../src/runtime/windows-processcontainer-sandbox.js';

function comparable(candidate) {
  const normalized = path.normalize(path.resolve(candidate));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function directoryLink(target, linkPath) {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

test('workspace trust anchor permits host-managed ancestor aliases', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspace-anchor-'));
  try {
    const realParent = path.join(root, 'real-parent');
    const realWorkspace = path.join(realParent, 'workspace');
    const realProject = path.join(realWorkspace, 'project');
    const aliasParent = path.join(root, 'alias-parent');
    await mkdir(realProject, { recursive: true });
    try {
      await directoryLink(realParent, aliasParent);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`directory-link fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }

    const aliasedWorkspace = path.join(aliasParent, 'workspace');
    const aliasedProject = path.join(aliasedWorkspace, 'project');
    const canonical = await canonicalizeWindowsWorkspacePath(aliasedWorkspace, aliasedProject, {
      name: 'sandbox project root',
      directory: true,
    });

    assert.equal(comparable(canonical), comparable(await realpath(realProject)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace trust anchor rejects new filesystem indirection below the anchor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspace-indirection-'));
  try {
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    const outsideProject = path.join(outside, 'project');
    const redirect = path.join(workspace, 'redirect');
    await mkdir(workspace, { recursive: true });
    await mkdir(outsideProject, { recursive: true });
    try {
      await directoryLink(outside, redirect);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`directory-link fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => canonicalizeWindowsWorkspacePath(workspace, path.join(redirect, 'project'), {
        name: 'sandbox project root',
        directory: true,
      }),
      /resolves through filesystem indirection inside managed workspace/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace-contained read roots reuse the canonical workspace trust anchor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-readroot-anchor-'));
  try {
    const realParent = path.join(root, 'real-parent');
    const realWorkspace = path.join(realParent, 'workspace');
    const realReadRoot = path.join(realWorkspace, 'reference');
    const aliasParent = path.join(root, 'alias-parent');
    await mkdir(realReadRoot, { recursive: true });
    try {
      await directoryLink(realParent, aliasParent);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`directory-link fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }

    const aliasedWorkspace = path.join(aliasParent, 'workspace');
    const aliasedReadRoot = path.join(aliasedWorkspace, 'reference');
    const canonical = await canonicalizeWindowsReadRootPath(aliasedWorkspace, aliasedReadRoot);

    assert.equal(comparable(canonical), comparable(await realpath(realReadRoot)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read roots outside the workspace stay strict about filesystem indirection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-readroot-external-'));
  try {
    const workspace = path.join(root, 'workspace');
    const realExternal = path.join(root, 'external-real');
    const aliasedExternal = path.join(root, 'external-alias');
    await mkdir(workspace, { recursive: true });
    await mkdir(realExternal, { recursive: true });
    try {
      await directoryLink(realExternal, aliasedExternal);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`directory-link fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => canonicalizeWindowsReadRootPath(workspace, aliasedExternal),
      /(?:must not be|resolves through) filesystem indirection/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MXC executions receive unique locally generated AppContainer identities', () => {
  const first = createWindowsProcessContainerId();
  const second = createWindowsProcessContainerId();
  assert.match(first, /^devbridge-[0-9a-f]{32}$/u);
  assert.match(second, /^devbridge-[0-9a-f]{32}$/u);
  assert.notEqual(first, second);
});

test('MXC verification wrappers outlive the upstream DACL mutex wait bound', () => {
  const timeouts = windowsProcessContainerProbeTimeouts();
  assert.ok(timeouts.prerequisiteMs > 30_000);
  assert.ok(timeouts.boundaryMs > 30_000);
  assert.ok(timeouts.boundaryMs > timeouts.prerequisiteMs);
});
