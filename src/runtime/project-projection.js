import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const OMITTED_ROOT_NAMES = new Set(['.git', '.devbridge']);
const PROJECTION_PARENT = '.devbridge-windows-projections';

function comparable(candidate) {
  const normalized = path.normalize(path.resolve(candidate));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function depth(relative) {
  return relative.split(path.sep).filter(Boolean).length;
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function canonicalWorkspaceRoot(candidate) {
  const resolved = path.resolve(candidate);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PolicyError('sandbox workspace root must be a real non-symlink directory');
  }
  // The host may expose the workspace through a stable ancestor junction or
  // drive alias (GitHub Actions does this on Windows). Treat the real path of
  // the workspace itself as the trust anchor, then reject any new indirection
  // introduced below that anchor.
  return realpath(resolved);
}

function workspaceRelativePath(workspaceRoot, workspaceCanonical, candidate, name) {
  const resolved = path.resolve(candidate);
  if (isWithin(workspaceRoot, resolved)) return path.relative(path.resolve(workspaceRoot), resolved);
  if (isWithin(workspaceCanonical, resolved)) return path.relative(path.resolve(workspaceCanonical), resolved);
  throw new PolicyError(`${name} must stay inside the managed workspace root`);
}

async function canonicalWorkspaceDescendant(workspaceRoot, workspaceCanonical, candidate, name) {
  const resolved = path.resolve(candidate);
  const relative = workspaceRelativePath(workspaceRoot, workspaceCanonical, resolved, name);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PolicyError(`${name} must be a real non-symlink directory`);
  }
  const canonical = await realpath(resolved);
  const expectedCanonical = path.resolve(workspaceCanonical, relative);
  if (comparable(canonical) !== comparable(expectedCanonical)) {
    throw new PolicyError(`${name} resolves through filesystem indirection inside managed workspace`);
  }
  return canonical;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function scanTree(root, { proposal = false } = {}) {
  const manifest = new Map();

  async function visit(directory, parentRelative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = parentRelative ? path.join(parentRelative, entry.name) : entry.name;
      if (OMITTED_ROOT_NAMES.has(entry.name.toLowerCase())) {
        if (!proposal && parentRelative === '') continue;
        throw new PolicyError(`project proposal contains protected path ${relative}`);
      }
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new PolicyError(`project proposal crosses filesystem indirection at ${relative}`);
      if (info.isDirectory()) {
        manifest.set(relative, { kind: 'directory' });
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) throw new PolicyError(`project proposal contains unsupported filesystem object at ${relative}`);
      manifest.set(relative, {
        kind: 'file',
        size: info.size,
        sha256: await sha256File(absolute),
      });
    }
  }

  await visit(root);
  return manifest;
}

function manifestsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [relative, expected] of left) {
    const actual = right.get(relative);
    if (!actual || actual.kind !== expected.kind) return false;
    if (expected.kind === 'file' && (actual.size !== expected.size || actual.sha256 !== expected.sha256)) return false;
  }
  return true;
}

async function materialize(sourceRoot, targetRoot, manifest) {
  const directories = [...manifest.entries()]
    .filter(([, value]) => value.kind === 'directory')
    .sort(([left], [right]) => depth(left) - depth(right));
  for (const [relative] of directories) await mkdir(path.join(targetRoot, relative), { recursive: true, mode: 0o700 });

  for (const [relative, value] of manifest) {
    if (value.kind !== 'file') continue;
    const destination = path.join(targetRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(path.join(sourceRoot, relative), destination);
  }
}

async function validateProposalTargets(sourceRoot, proposal) {
  const sourceCanonical = await realpath(sourceRoot);
  for (const relative of proposal.keys()) {
    let prefix = '';
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      prefix = prefix ? path.join(prefix, segment) : segment;
      const target = path.join(sourceRoot, prefix);
      let info;
      try {
        info = await lstat(target);
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new PolicyError(`project proposal target crosses filesystem indirection at ${prefix}`);
      }
      const canonical = await realpath(target);
      const expected = path.join(sourceCanonical, prefix);
      if (comparable(canonical) !== comparable(expected)) {
        throw new PolicyError(`project proposal target resolves through an alternate filesystem name at ${prefix}`);
      }
    }
  }
}

async function applyManifest(sourceRoot, proposalRoot, baseline, proposal) {
  const removals = [...baseline.entries()]
    .filter(([relative, value]) => !proposal.has(relative) || proposal.get(relative).kind !== value.kind)
    .sort(([left], [right]) => depth(right) - depth(left));
  for (const [relative] of removals) await rm(path.join(sourceRoot, relative), { recursive: true, force: true });

  const directories = [...proposal.entries()]
    .filter(([, value]) => value.kind === 'directory')
    .sort(([left], [right]) => depth(left) - depth(right));
  for (const [relative] of directories) await mkdir(path.join(sourceRoot, relative), { recursive: true, mode: 0o700 });

  for (const [relative, value] of proposal) {
    if (value.kind !== 'file') continue;
    const prior = baseline.get(relative);
    if (prior?.kind === 'file' && prior.sha256 === value.sha256 && prior.size === value.size) continue;
    const destination = path.join(sourceRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(path.join(proposalRoot, relative), destination);
  }
}

export async function createGitlessProjectProjection({ workspaceRoot, projectDir }) {
  const workspaceResolved = path.resolve(workspaceRoot);
  const workspace = await canonicalWorkspaceRoot(workspaceResolved);
  const source = await canonicalWorkspaceDescendant(
    workspaceResolved,
    workspace,
    projectDir,
    'sandbox project root',
  );

  const gitAdmin = path.join(source, '.git');
  if (!(await exists(gitAdmin))) {
    return {
      projected: false,
      sourceProjectDir: source,
      projectDir: source,
      async importChanges() {},
      async cleanup() {},
    };
  }
  const gitInfo = await lstat(gitAdmin);
  if (gitInfo.isSymbolicLink()) throw new PolicyError('sandbox Git administrative path must not be filesystem indirection');
  if (comparable(source) === comparable(workspace)) {
    throw new PolicyError('Git-bearing sandbox project root must be a descendant of the managed workspace root so its proposal projection stays outside the project');
  }

  const baseline = await scanTree(source);
  const parent = path.join(workspace, PROJECTION_PARENT);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const projection = await mkdtemp(path.join(parent, 'project-'));
  let cleaned = false;

  try {
    await materialize(source, projection, baseline);
    const sourceAfterMaterialize = await scanTree(source);
    if (!manifestsEqual(baseline, sourceAfterMaterialize)) {
      throw new PolicyError('sandbox project changed while the Gitless proposal projection was being materialized');
    }
  } catch (error) {
    await rm(projection, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    projected: true,
    sourceProjectDir: source,
    projectDir: projection,
    async importChanges() {
      const currentSource = await scanTree(source);
      if (!manifestsEqual(baseline, currentSource)) {
        throw new PolicyError('sandbox project changed outside the contained proposal while it was running; refusing to import stale proposal bytes');
      }
      const proposal = await scanTree(projection, { proposal: true });
      await validateProposalTargets(source, proposal);
      await applyManifest(source, projection, baseline, proposal);
      const imported = await scanTree(source);
      if (!manifestsEqual(proposal, imported)) {
        throw new PolicyError('sandbox project proposal import did not reproduce the contained project state exactly');
      }
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(projection, { recursive: true, force: true });
      try {
        const remaining = await readdir(parent);
        if (remaining.length === 0) await rmdir(parent);
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
      }
    },
  };
}
