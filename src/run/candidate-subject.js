import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digestObject(value) {
  return sha256(JSON.stringify(stable(value)));
}

async function pathEntry(worktreeDir, relative) {
  const normalized = String(relative).replace(/\\/g, '/');
  const target = path.resolve(worktreeDir, relative);
  const rel = path.relative(path.resolve(worktreeDir), target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new PolicyError(`candidate subject path escaped worktree: ${relative}`);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      const link = await readlink(target);
      return { path: normalized, state: 'present', kind: 'symlink', size: Buffer.byteLength(link, 'utf8'), sha256: sha256(Buffer.from(link, 'utf8')) };
    }
    if (!info.isFile()) throw new PolicyError(`candidate subject supports only files/symlinks: ${relative}`);
    const bytes = await readFile(target);
    return { path: normalized, state: 'present', kind: 'file', size: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: normalized, state: 'absent', kind: null, size: 0, sha256: null };
    throw error;
  }
}

function pathRisk(pathname, entry) {
  const p = pathname.replace(/\\/g, '/').toLowerCase();
  const risks = new Set();
  if (entry?.state === 'absent') risks.add('destructive');
  if (
    p === 'agents.md' ||
    p === 'package.json' ||
    p === 'patch-poller.mjs' ||
    p === 'src/config.js' ||
    p === 'src/app/runtime.js' ||
    p === 'src/run/run-coordinator.js' ||
    p.startsWith('src/security/') ||
    p.startsWith('src/bootstrap/') ||
    p.startsWith('src/git/') ||
    p.startsWith('src/github/') ||
    p.startsWith('src/runtime/sandbox') ||
    p === 'src/runtime/cli-profile.js' ||
    p.startsWith('.github/workflows/') ||
    p.startsWith('release/') ||
    p.startsWith('config/')
  ) risks.add('control-plane');
  if (
    p.startsWith('specs/') ||
    p.includes('/schema') ||
    p.endsWith('.schema.json') ||
    p.endsWith('-protocol.md') ||
    p.endsWith('-contract.md')
  ) risks.add('contract');
  return risks;
}

function architectureSignal(paths) {
  if (paths.length < 12) return false;
  const owners = new Set(paths.map((value) => value.replace(/\\/g, '/').split('/').slice(0, 2).join('/')));
  return owners.size >= 4;
}

export async function buildCandidateArtifactSubject(workspace, snapshot) {
  const files = [];
  for (const relative of [...snapshot.changedFiles].sort()) files.push(await pathEntry(workspace.worktreeDir, relative));
  const subject = {
    protocol: 'patch-poller/candidate-artifact-v1',
    repository: workspace.repository,
    baselineSha: workspace.baseSha,
    files,
  };
  return { subject, digest: digestObject(subject) };
}

export function classifyCandidateDecision(artifactSubject) {
  const paths = artifactSubject.subject.files.map((entry) => entry.path).sort();
  const risks = new Set();
  for (const entry of artifactSubject.subject.files) {
    for (const risk of pathRisk(entry.path, entry)) risks.add(risk);
  }
  if (architectureSignal(paths)) risks.add('architecture');
  if (risks.size === 0) return null;

  let decisionClass;
  let bindingMode;
  if (risks.has('destructive')) {
    decisionClass = 'destructive';
    bindingMode = 'artifact-exact';
  } else if (risks.has('control-plane')) {
    decisionClass = 'control-plane';
    bindingMode = 'artifact-exact';
  } else if (risks.has('contract')) {
    decisionClass = 'contract';
    bindingMode = 'decision-scope';
  } else {
    decisionClass = 'architecture';
    bindingMode = 'decision-scope';
  }

  const scope = {
    protocol: 'patch-poller/decision-scope-v1',
    repository: artifactSubject.subject.repository,
    baselineSha: artifactSubject.subject.baselineSha,
    decisionClass,
    risks: [...risks].sort(),
    paths,
  };
  const scopeDigest = digestObject(scope);
  return {
    decisionClass,
    bindingMode,
    risks: [...risks].sort(),
    paths,
    scope,
    scopeDigest,
    subjectDigest: bindingMode === 'artifact-exact' ? artifactSubject.digest : scopeDigest,
  };
}

export function checkpointIdForDecision(runId, taskRevision, decision) {
  const key = digestObject({ runId, taskRevision, decisionClass: decision.decisionClass, scopeDigest: decision.scopeDigest });
  return `gate-${decision.decisionClass}-${key.slice(0, 20)}`;
}
