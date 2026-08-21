import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitClient } from '../src/git/git-client.js';
import {
  classifyRepositoryAdmissionFailure,
  inspectRepositoryAdmission,
  sanitizeGitRemote,
} from '../src/git/repository-admission.js';

const exec = promisify(execFile);

function failure(args, stderr, extra = {}) {
  return { args, cwd: '/local/private/path', exitCode: 128, signal: null, timedOut: false, stdout: '', stderr, ...extra };
}

test('classifies authentication without exposing raw credential diagnostics', () => {
  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const result = classifyRepositoryAdmissionFailure(failure(
    ['clone', 'https://github.com/owner/repo.git', '/managed/repo'],
    `fatal: Authentication failed for 'https://x-access-token:${secret}@github.com/owner/repo.git/'`
  ));
  assert.equal(result.code, 'REPOSITORY_ADMISSION_FAILED');
  assert.equal(result.phase, 'clone');
  assert.equal(result.kind, 'authentication');
  assert.match(result.repair, /reauthenticate/u);
  assert.doesNotMatch(result.message, new RegExp(secret, 'u'));
  assert.doesNotMatch(result.message, /github\.com\/owner\/repo/u);
});

test('distinguishes authorization, hidden repository, ref, worktree, corruption, and timeout repair classes', () => {
  assert.equal(classifyRepositoryAdmissionFailure(failure(['fetch', 'origin'], 'remote: HTTP 403 access denied')).kind, 'authorization');
  assert.equal(classifyRepositoryAdmissionFailure(failure(['ls-remote', 'origin', 'HEAD'], 'remote: Repository not found.')).kind, 'repository-not-visible');
  assert.equal(classifyRepositoryAdmissionFailure(failure(['fetch', 'origin'], 'fatal: remote ref refs/heads/missing not found')).kind, 'fetch-or-ref');
  assert.equal(classifyRepositoryAdmissionFailure(failure(['worktree', 'add', '/managed/run', 'branch'], "fatal: 'branch' is already checked out at '/other'" )).kind, 'worktree-collision');
  assert.equal(classifyRepositoryAdmissionFailure(failure(['cat-file', '-e', 'deadbeef^{commit}'], 'fatal: loose object abc is corrupt')).kind, 'local-corruption');
  assert.equal(classifyRepositoryAdmissionFailure(failure(['fetch', 'origin'], '', { timedOut: true, exitCode: null })).kind, 'timeout');
});

test('sanitizes credential-bearing remote URLs', () => {
  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const sanitized = sanitizeGitRemote(`https://x-access-token:${secret}@github.com/owner/repo.git?token=${secret}#fragment`);
  assert.equal(sanitized, 'https://github.com/owner/repo.git');
  assert.doesNotMatch(sanitized, /x-access-token|github_pat_|token=|fragment/u);
});

test('GitClient never returns embedded remote credentials from remote get-url', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-admission-origin-'));
  await exec('git', ['init', root]);
  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  await exec('git', ['-C', root, 'remote', 'add', 'origin', `https://x-access-token:${secret}@github.com/owner/repo.git`]);
  const client = new GitClient({ syntheticHome: path.join(root, 'git-home') });
  const observed = await client.run(['remote', 'get-url', 'origin'], { cwd: root });
  assert.equal(observed.stdout.trim(), 'https://github.com/owner/repo.git');
  assert.doesNotMatch(observed.stdout, new RegExp(secret, 'u'));
});

test('read-only admission probe returns exact remote head without exposing remote or credential', async () => {
  const calls = [];
  const head = 'a'.repeat(40);
  const result = await inspectRepositoryAdmission({
    repository: 'owner/repo',
    remoteUrl: 'https://github.com/owner/repo.git',
    token: 'secret-local-token',
    run: async (args, options) => {
      calls.push({ args, options });
      return {
        args,
        cwd: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `ref: refs/heads/main\tHEAD\n${head}\tHEAD\n`,
        stderr: '',
      };
    },
  });
  assert.deepEqual(result, {
    repository: 'owner/repo',
    ready: true,
    code: null,
    phase: 'remote-access',
    kind: null,
    repair: null,
    defaultRef: 'refs/heads/main',
    headSha: head,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ['ls-remote', '--symref']);
  assert.equal(calls[0].options.allowFailure, true);
  assert.equal(calls[0].options.authBaseUrl, 'https://github.com/');
  assert.equal(Object.hasOwn(result, 'remoteUrl'), false);
  assert.equal(Object.hasOwn(result, 'token'), false);
});

test('read-only admission probe returns a bounded repair class on failure', async () => {
  const result = await inspectRepositoryAdmission({
    repository: 'owner/private',
    remoteUrl: 'https://github.com/owner/private.git',
    run: async (args) => failure(args, 'remote: Repository not found.'),
  });
  assert.equal(result.ready, false);
  assert.equal(result.code, 'REPOSITORY_ADMISSION_FAILED');
  assert.equal(result.phase, 'remote-access');
  assert.equal(result.kind, 'repository-not-visible');
  assert.match(result.repair, /credential can see it/u);
  assert.equal(result.defaultRef, null);
  assert.equal(result.headSha, null);
});
