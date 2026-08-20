import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createFastHostRepositoryExecution } from '../src/app/fast-host-repository-execution.js';
import { composeWorkRunner } from '../src/app/work-runner-composition.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';

const run = promisify(execFile);
const enabled = process.env.DEVBRIDGE_REAL_CODEX_SMOKE === '1';

test('real Codex fallback completes one DevBridge work turn', { skip: !enabled, timeout: 300_000 }, async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'db-codex-project-'));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'db-codex-state-'));
  await run('git', ['init'], { cwd: projectDir });

  const execution = createFastHostRepositoryExecution({
    stateDirectory,
    rootFor: async () => projectDir,
    resolveTool: async () => ({ program: 'codex', arguments: [] }),
  });
  const runner = composeWorkRunner({
    mailboxStore: new WorkerExchange({ stateDirectory }),
    activeExecution: execution,
  });
  const result = await runner.run({
    profile: {
      name: 'codex-fast',
      args: [
        '--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--model', 'gpt-5.5',
        '--ephemeral', '--sandbox', 'workspace-write',
        '--color', 'never', '--output-last-message', '{resultFile}', '-',
      ],
      inputMode: 'stdin-json',
      timeoutMs: 240_000,
      maxOutputBytes: 4 * 1024 * 1024,
      environment: { pass: [], set: {} },
    },
    projectDir,
    runDir: path.join(projectDir, '.devbridge', 'smoke', 'turn-1'),
    runId: 'smoke',
    repository: 'owner/project',
    repositoryId: '1',
    context: {
      task: {
        summary: 'Do not edit files or run commands. Return exactly one JSON result with status complete and summary Codex adapter ready.',
      },
      constraints: ['This is a connection smoke test.'],
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.resultParseError, null);
  assert.equal(result.result?.status, 'complete');
  assert.match(result.result?.summary ?? '', /Codex adapter ready/iu);
});
