#!/usr/bin/env node

import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createRuntimeExecutionContext } from '../../src/app/runtime-execution.js';
import { GitClient } from '../../src/git/git-client.js';
import { REPOSITORY_EXECUTION_REQUEST_PROTOCOL } from '../../src/runtime/repository-execution.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function argumentsFor(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && index + 1 < process.argv.length) values.push(process.argv[index + 1]);
  }
  return values;
}

function repositoryName(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) throw new Error('repository must be owner/name');
  return value;
}

function repositoryId(value) {
  if (!/^\d+$/u.test(value)) throw new Error('repository ID must be a numeric immutable identity');
  return value;
}

function testFile(value) {
  const normalized = String(value).replace(/\\/gu, '/');
  if (normalized.length === 0 || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('test file must be a safe repository-relative path');
  }
  return normalized;
}

const repositoryRoot = path.resolve(argument('--repository-root'));
const config = await loadConfig(path.resolve(argument('--config')));
const repository = repositoryName(argument('--repository'));
const stableRepositoryId = repositoryId(argument('--repository-id'));
const probeFile = testFile(argument('--probe-file'));
const testFiles = argumentsFor('--test-file').map(testFile);
const gitClient = new GitClient({
  executable: config.git.executable,
  syntheticHome: path.join(config.state.directory, 'fast-vm-smoke-git-home'),
});
const runtime = await createRuntimeExecutionContext({
  config,
  workspaceManager: { worktreePath: () => repositoryRoot },
  gitClient,
  client: { request: async () => { throw new Error('smoke scope already carries the stable repository identity'); } },
  protectedValues: [],
});

async function execute(operation, argumentsList, timeoutMs) {
  const result = await runtime.repositoryExecution.execute({
    protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation,
    scope: { repository, repositoryId: stableRepositoryId, runId: 'fast-vm-smoke' },
    invocation: { tool: 'node', arguments: argumentsList, workingDirectory: '.' },
    environment: {},
    transfers: [],
    limits: { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
    stdin: null,
  });
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    throw new Error(`${operation} failed: ${result.stderr || result.stdout}`.slice(-4_096));
  }
  return result;
}

const platform = await execute('tool.probe:fast-vm-platform', [
  '-e',
  "const fs=require('node:fs');const marker=process.argv[1];const result={platform:process.platform,arch:process.arch,node:process.version,source:fs.existsSync(marker)};if(result.platform!=='linux'||!result.source)process.exitCode=1;console.log(JSON.stringify(result));",
  probeFile,
], 60_000);
const tests = testFiles.length === 0
  ? null
  : await execute('runtime.validate:fast-vm-tests', ['--test', ...testFiles], 10 * 60_000);

process.stdout.write(`${JSON.stringify({
  status: runtime.repositoryExecution.inspect(),
  platform: JSON.parse(platform.stdout.trim()),
  tests: tests == null ? null : {
    exitCode: tests.exitCode,
    stdoutTail: tests.stdout.slice(-2_048),
    evidence: tests.evidence,
  },
})}\n`);
