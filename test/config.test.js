import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function base() {
  return {
    version: 1,
    github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.resolve('/tmp/patch-poller-workspace'), allowedOwners: ['iteathen'] },
    state: { directory: path.resolve('/tmp/patch-poller-state') },
    execution: {},
    status: {},
    tools: {}
  };
}

test('uses conservative API, auth, execution, Git, and publication defaults', () => {
  const config = validateConfig(base());
  assert.equal(config.github.apiVersion, '2026-03-10');
  assert.equal(config.github.rateLimit.reserveRatio, 0.2);
  assert.equal(config.github.auth.mode, 'auto');
  assert.deepEqual(config.github.auth.environmentVariables, [
    'PATCH_POLLER_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]);
  assert.equal(config.github.auth.githubCliExecutable, 'gh');
  assert.equal(config.github.auth.hostname, 'github.com');
  assert.equal(config.execution.enabled, false);
  assert.deepEqual(config.workspace.externalReadRoots, []);
  assert.equal(config.git.executable, 'git');
  assert.equal(config.publication.autoPushTaskBranches, false);
  assert.equal(config.publication.branchPrefix, 'patchpoller');
});

test('legacy github.tokenEnv remains first while standard environment fallbacks are added', () => {
  const raw = base();
  raw.github.tokenEnv = 'UAI_GITHUB_TOKEN';
  const config = validateConfig(raw);
  assert.deepEqual(config.github.auth.environmentVariables, [
    'UAI_GITHUB_TOKEN',
    'PATCH_POLLER_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]);
  assert.equal(config.github.tokenEnv, 'UAI_GITHUB_TOKEN');
});

test('explicit GitHub auth configuration can constrain the local credential method', () => {
  const raw = base();
  raw.github.auth = {
    mode: 'environment',
    environmentVariables: ['LOCAL_ONLY_GITHUB_TOKEN'],
    githubCliExecutable: 'gh-custom',
    hostname: 'github.example.com',
  };
  const config = validateConfig(raw);
  assert.deepEqual(config.github.auth, {
    mode: 'environment',
    environmentVariables: ['LOCAL_ONLY_GITHUB_TOKEN'],
    githubCliExecutable: 'gh-custom',
    hostname: 'github.example.com',
  });
});
