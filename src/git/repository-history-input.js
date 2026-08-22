import { createHash } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const COMMIT = /^[0-9a-f]{40}$/u;
const REMOTE_REF = /^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,239}$/u;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

function exactCommit(value) {
  const text = String(value ?? '').toLowerCase();
  if (!COMMIT.test(text)) throw new PolicyError('repository history input subject must be an exact 40-hex commit');
  return text;
}

function exactRemoteRef(value) {
  const text = String(value ?? '');
  if (!REMOTE_REF.test(text) || text.includes('..') || text.endsWith('/') || text.includes('//')) {
    throw new PolicyError('repository history input source ref is invalid');
  }
  return text;
}

function scratchId(name) {
  return `input-${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)}`;
}

export function createRepositoryHistoryInput({ gitClient, subject, sourceRef, destination } = {}) {
  if (!gitClient || typeof gitClient.run !== 'function') throw new TypeError('repository history input git client is required');
  const commit = exactCommit(subject);
  const ref = exactRemoteRef(sourceRef);
  if (typeof destination !== 'string' || destination.length === 0) throw new TypeError('repository history input destination is required');

  return Object.freeze({
    destination,
    async load({ projectDir, scratch, name }) {
      const present = await gitClient.run(['cat-file', '-e', `${commit}^{commit}`], { cwd: projectDir, allowFailure: true });
      if (present.exitCode !== 0) throw new PolicyError('locally registered repository history subject is unavailable');

      const ancestor = await gitClient.run(['merge-base', '--is-ancestor', commit, ref], { cwd: projectDir, allowFailure: true });
      if (ancestor.exitCode !== 0) throw new PolicyError('locally registered repository history subject is outside the admitted source lineage');

      const directory = await scratch.directory(scratchId(name));
      const bundle = path.join(directory, 'input.bundle');
      await rm(bundle, { force: true });
      await gitClient.run(['bundle', 'create', bundle, ref], { cwd: projectDir });

      const head = await gitClient.run(['bundle', 'list-heads', bundle, ref], { cwd: projectDir, allowFailure: true });
      const line = String(head.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean);
      if (head.exitCode !== 0 || line.length !== 1) throw new PolicyError('repository history input bundle head could not be verified');
      const [headCommit, headRef, ...extra] = line[0].split(/\s+/u);
      if (!COMMIT.test(headCommit ?? '') || headRef !== ref || extra.length !== 0) throw new PolicyError('repository history input bundle advertised an unexpected head');

      const info = await lstat(bundle);
      if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_BUNDLE_BYTES) {
        throw new PolicyError('repository history input bundle has an invalid bounded shape');
      }
      const bytes = await readFile(bundle);
      if (bytes.length !== info.size) throw new PolicyError('repository history input bundle changed during readback');
      return { bytes, subject: commit };
    },
  });
}
