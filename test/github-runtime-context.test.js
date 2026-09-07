import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGitHubRuntimeContext,
  GITHUB_RUNTIME_CONTEXT_PROTOCOL,
} from '../src/app/github-runtime-context.js';

test('shared GitHub runtime context owns credential and budget authority without queue topology', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-github-context-'));
  const context = await createGitHubRuntimeContext({
    apiVersion: '2026-03-10',
    rateLimit: { reserveRatio: 0.2, minimumReserve: 250, emergencyReserve: 25, mutationIntervalMs: 1100 },
    auth: { mode: 'environment', environmentVariables: ['DB_TEST_TOKEN'], githubCliExecutable: 'gh', hostname: 'github.com' },
    stateDirectory: root,
    env: { DB_TEST_TOKEN: 'shared-secret' },
    fetchImpl: async () => { throw new Error('construction must not issue a request'); },
  });

  assert.equal(context.protocol, GITHUB_RUNTIME_CONTEXT_PROTOCOL);
  assert.equal(await context.tokenProvider(), 'shared-secret');
  assert.deepEqual(context.secretValues, ['shared-secret']);
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(context.rateBudget.snapshot(), {
    limit: null, remaining: null, used: null, resetAt: null, resource: null, pollIntervalMs: null,
  });

  const source = await readFile(fileURLToPath(new URL('../src/app/github-runtime-context.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /queueRepositories|queueRepository|repository identity|runtime collection/u);
});
