import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

function splitRepository(repository) {
  if (typeof repository !== 'string') throw new PolicyError('repository identity must be a string');
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !SEGMENT_RE.test(part) || part === '.' || part === '..')) {
    throw new PolicyError('repository identity must be safe owner/name');
  }
  return parts;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new PolicyError(`no existing ancestor for ${candidate}`);
      current = parent;
    }
  }
}

export class WorkspacePolicy {
  #root;
  #allowedOwners;

  constructor({ root, allowedOwners }) {
    this.#root = path.resolve(root);
    this.#allowedOwners = new Set(allowedOwners.map((owner) => owner.toLowerCase()));
  }

  get root() {
    return this.#root;
  }

  async ensureRoot() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    return realpath(this.#root);
  }

  projectPath(repository) {
    const [owner, name] = splitRepository(repository);
    if (!this.#allowedOwners.has(owner.toLowerCase())) {
      throw new PolicyError(`repository owner ${owner} is not allowed by local policy`);
    }
    const candidate = path.join(this.#root, 'repositories', owner, name);
    if (!isWithin(this.#root, candidate)) throw new PolicyError('resolved project path escaped workspace root');
    return candidate;
  }

  async assertWriteContained(candidate) {
    const rootReal = await this.ensureRoot();
    const resolvedCandidate = path.resolve(candidate);
    if (!isWithin(this.#root, resolvedCandidate)) {
      throw new PolicyError(`write path escapes managed workspace: ${candidate}`);
    }

    const existingAncestor = await nearestExistingAncestor(resolvedCandidate);
    const ancestorReal = await realpath(existingAncestor);
    if (!isWithin(rootReal, ancestorReal)) {
      throw new PolicyError(`write path escapes managed workspace through symlink/junction: ${candidate}`);
    }

    try {
      const info = await lstat(resolvedCandidate);
      if (info.isSymbolicLink()) {
        const candidateReal = await realpath(resolvedCandidate);
        if (!isWithin(rootReal, candidateReal)) throw new PolicyError(`symlink write path escapes workspace: ${candidate}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    return resolvedCandidate;
  }
}

export { isWithin, splitRepository };
