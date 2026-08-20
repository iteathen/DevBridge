import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createGitlessProjectProjection } from '../src/runtime/project-projection.js';

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function directoryLink(target, linkPath) {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

test('Gitless project projection imports proposal bytes without exposing Git administrative state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-project-projection-'));
  const workspace = path.join(root, 'workspace');
  const project = path.join(workspace, 'project');
  try {
    await mkdir(path.join(project, '.git'), { recursive: true });
    await writeFile(path.join(project, '.git', 'config'), 'git-sentinel\n');
    await writeFile(path.join(project, 'README.md'), 'before\n');
    await writeFile(path.join(project, 'obsolete.txt'), 'remove-me\n');

    const view = await createGitlessProjectProjection({ workspaceRoot: workspace, projectDir: project });
    assert.equal(view.projected, true);
    assert.equal(await exists(path.join(view.projectDir, '.git')), false);

    await writeFile(path.join(view.projectDir, 'README.md'), 'after\n');
    await writeFile(path.join(view.projectDir, 'created.txt'), 'created\n');
    await rm(path.join(view.projectDir, 'obsolete.txt'));
    await view.importChanges();

    assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), 'after\n');
    assert.equal(await readFile(path.join(project, 'created.txt'), 'utf8'), 'created\n');
    assert.equal(await exists(path.join(project, 'obsolete.txt')), false);
    assert.equal(await readFile(path.join(project, '.git', 'config'), 'utf8'), 'git-sentinel\n');
    await view.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Gitless project projection accepts a host-managed workspace ancestor alias', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-project-projection-alias-'));
  try {
    const realParent = path.join(root, 'real-parent');
    const realWorkspace = path.join(realParent, 'workspace');
    const realProject = path.join(realWorkspace, 'project');
    const aliasParent = path.join(root, 'alias-parent');
    await mkdir(path.join(realProject, '.git'), { recursive: true });
    await writeFile(path.join(realProject, '.git', 'config'), 'git-sentinel\n');
    await writeFile(path.join(realProject, 'README.md'), 'before\n');
    try {
      await directoryLink(realParent, aliasParent);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`directory-link fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }

    const workspace = path.join(aliasParent, 'workspace');
    const project = path.join(workspace, 'project');
    const view = await createGitlessProjectProjection({ workspaceRoot: workspace, projectDir: project });
    try {
      assert.equal(view.projected, true);
      assert.equal(await exists(path.join(view.projectDir, '.git')), false);
      await writeFile(path.join(view.projectDir, 'README.md'), 'after\n');
      await view.importChanges();
      assert.equal(await readFile(path.join(realProject, 'README.md'), 'utf8'), 'after\n');
      assert.equal(await readFile(path.join(realProject, '.git', 'config'), 'utf8'), 'git-sentinel\n');
    } finally {
      await view.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Gitless project projection rejects worker-created case-variant Git administrative paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-project-projection-git-'));
  const workspace = path.join(root, 'workspace');
  const project = path.join(workspace, 'project');
  try {
    await mkdir(path.join(project, '.git'), { recursive: true });
    await writeFile(path.join(project, '.git', 'config'), 'git-sentinel\n');
    await writeFile(path.join(project, 'README.md'), 'before\n');
    const view = await createGitlessProjectProjection({ workspaceRoot: workspace, projectDir: project });
    try {
      await mkdir(path.join(view.projectDir, '.GIT'));
      await writeFile(path.join(view.projectDir, '.GIT', 'config'), 'worker-git\n');
      await assert.rejects(() => view.importChanges(), /protected path/u);
      assert.equal(await readFile(path.join(project, '.git', 'config'), 'utf8'), 'git-sentinel\n');
      assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), 'before\n');
    } finally {
      await view.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Gitless project projection refuses to overwrite controller-side source drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-project-projection-drift-'));
  const workspace = path.join(root, 'workspace');
  const project = path.join(workspace, 'project');
  try {
    await mkdir(path.join(project, '.git'), { recursive: true });
    await writeFile(path.join(project, '.git', 'config'), 'git-sentinel\n');
    await writeFile(path.join(project, 'README.md'), 'baseline\n');
    const view = await createGitlessProjectProjection({ workspaceRoot: workspace, projectDir: project });
    try {
      await writeFile(path.join(view.projectDir, 'README.md'), 'proposal\n');
      await writeFile(path.join(project, 'README.md'), 'controller-drift\n');
      await assert.rejects(() => view.importChanges(), /changed outside the contained proposal/u);
      assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), 'controller-drift\n');
    } finally {
      await view.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-Git project uses its existing directory directly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-project-projection-plain-'));
  const workspace = path.join(root, 'workspace');
  const project = path.join(workspace, 'project');
  try {
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, 'fixture.txt'), 'plain\n');
    const view = await createGitlessProjectProjection({ workspaceRoot: workspace, projectDir: project });
    assert.equal(view.projected, false);
    assert.equal(path.resolve(view.projectDir), path.resolve(project));
    await view.importChanges();
    await view.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
