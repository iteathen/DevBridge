import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateRuntimeCandidate, candidateValidationAvailability } from '../src/bootstrap/candidate-validator.mjs';
import { runtimeArtifactSha256 } from '../src/bootstrap/release-integrity.mjs';
import { REPOSITORY_EXECUTION_RESULT_PROTOCOL, REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';

function context(seen, execute = null) {
  const scope = { repository: 'owner/runtime', repositoryId: '123', runId: 'runtime-a' };
  return {
    scope,
    execution: {
      inspect: () => ({ protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'validation-fixture', reason: null }),
      async execute(request) {
        seen.push(request);
        if (execute) await execute(request, seen.length);
        return {
          protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
          exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false,
          stdout: 'passed\n', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null,
          evidence: { identity: `check-${seen.length}`, scope },
        };
      },
    },
  };
}

test('candidate checks use only the isolated execution stud and suite-specific bounded timing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-candidate-no-provider-'));
  const candidateDir = path.join(root, 'candidate');
  const outside = path.join(root, 'escaped.txt');
  try {
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, 'candidate.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(outside)}, 'escaped');\n`);
    const runtime = { runtimeDir: candidateDir, head: 'a'.repeat(40), version: '0.1.0' };
    const seen = [];
    const result = await validateRuntimeCandidate({ home: root }, runtime, null, { executionContext: context(seen) });
    assert.equal(result.preflight, 'passed');
    assert.equal(result.tests, 'passed');
    assert.deepEqual(result.compatibility, { activeStage0Protocol: 0, requiredStage0Protocol: 0 });
    assert.deepEqual(seen.map((request) => request.operation), ['runtime.validate:preflight', 'runtime.validate:tests']);
    assert.ok(seen.every((request) => request.invocation.tool === 'node'));
    assert.ok(seen.every((request) => request.environment.DEVBRIDGE_STAGE0_PROTOCOL === '0'));
    assert.equal(seen[0].limits.timeoutMs, 4 * 60_000);
    assert.equal(seen[1].limits.timeoutMs, 2 * 60 * 60_000);
    assert.ok(seen[1].limits.timeoutMs > 30 * 60_000);
    assert.ok(seen[0].limits.timeoutMs < seen[1].limits.timeoutMs);
    await assert.rejects(readFile(outside), { code: 'ENOENT' });
    assert.deepEqual(candidateValidationAvailability(), { state: 'ready', ready: true, reason: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate Stage 0 compatibility is checked before candidate execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-candidate-stage0-'));
  try {
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
      name: 'devbridge', version: '0.1.0', devbridge: { bootstrap: { minimumStage0Protocol: 2 } },
    })}\n`);
    const runtime = { runtimeDir: root, head: 'd'.repeat(40), version: '0.1.0' };
    const blocked = [];
    await assert.rejects(
      () => validateRuntimeCandidate({ home: root }, runtime, null, {
        env: { DEVBRIDGE_STAGE0_PROTOCOL: '1' },
        executionContext: context(blocked),
      }),
      /requires Stage 0 protocol 2.*provides 1/u,
    );
    assert.equal(blocked.length, 0);

    await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
      name: 'devbridge', version: '0.1.0', devbridge: { bootstrap: { minimumStage0Protocol: 1 } },
    })}\n`);
    const admitted = [];
    const result = await validateRuntimeCandidate({ home: root }, runtime, null, {
      env: { DEVBRIDGE_STAGE0_PROTOCOL: '1' },
      executionContext: context(admitted),
    });
    assert.deepEqual(result.compatibility, { activeStage0Protocol: 1, requiredStage0Protocol: 1 });
    assert.equal(admitted.length, 2);
    assert.ok(admitted.every((request) => request.environment.DEVBRIDGE_STAGE0_PROTOCOL === '1'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('static candidate artifact identity is checked before and after isolated execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-candidate-digest-'));
  try {
    await writeFile(path.join(root, 'file.txt'), 'candidate\n');
    const runtime = { runtimeDir: root, head: 'b'.repeat(40), version: '0.1.0' };
    const digest = await runtimeArtifactSha256(root);
    const seen = [];
    await assert.rejects(() => validateRuntimeCandidate({ home: root }, runtime, null, { expectedArtifactSha256: '0'.repeat(64), executionContext: context(seen) }), /candidate artifact changed before validation/u);
    assert.equal(seen.length, 0);
    const result = await validateRuntimeCandidate({ home: root }, runtime, null, { expectedArtifactSha256: digest.sha256, executionContext: context(seen) });
    assert.equal(result.artifactSha256, digest.sha256);

    const changed = [];
    await assert.rejects(() => validateRuntimeCandidate({ home: root }, runtime, null, {
      expectedArtifactSha256: digest.sha256,
      executionContext: context(changed, async (_request, index) => {
        if (index === 2) await writeFile(path.join(root, 'file.txt'), 'changed\n');
      }),
    }), /changed during execution validation/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('default candidate validation fails closed when no local validation route exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-candidate-route-'));
  const runtimeDir = path.join(root, 'runtime');
  const configFile = path.join(root, 'config.json');
  try {
    await mkdir(runtimeDir);
    await writeFile(path.join(runtimeDir, 'candidate.mjs'), 'process.exitCode = 99;\n');
    await writeFile(configFile, `${JSON.stringify({
      version: 1,
      github: { queueRepositories: ['owner/queue'], trustedActorIds: ['1'] },
      workspace: { root: path.join(root, 'workspace'), allowedOwners: ['owner'], allowCreate: true },
      state: { directory: path.join(root, 'state') },
      execution: { enabled: false, controllerPlansEnabled: true, modelAdaptersEnabled: false },
      status: {}, tools: {},
    })}\n`);
    await assert.rejects(
      () => validateRuntimeCandidate({ home: root, config: configFile }, { runtimeDir, head: 'c'.repeat(40), version: '0.1.0' }, null, { env: {} }),
      /no local environment activity policy/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
