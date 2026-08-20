import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitlessProjectProjection } from '../src/runtime/project-projection.js';

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
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

test('Gitless project projection rejects worker-created Git administrative paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-project-projection-git-'));
  const workspace = path.join(root, 'workspace');
  const project = path.join(workspace, 'project');
  try {
    await mkdir(path.join(project, '.git'), { recursive: true });
    await writeFile(path.join(project, '.git', 'config'), 'git-sentinel\n');
    await writeFile(path.join(project, 'README.md'), 'before\n');
    const view = await createGitlessProjectProjection({ workspaceRoot: workspace, projectDir: project });
    try {
      await mkdir(path.join(view.projectDir, '.git'));
      await writeFile(path.join(view.projectDir, '.git', 'config'), 'worker-git\n');
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
