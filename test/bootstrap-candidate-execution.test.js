import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateRuntimeCandidate, candidateValidationAvailability } from '../src/bootstrap/candidate-validator.mjs';
import { runtimeArtifactSha256 } from '../src/bootstrap/release-integrity.mjs';

test('Stage 1 candidate-controlled execution is explicitly unavailable and never runs candidate code on the host', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-candidate-no-provider-'));
  const candidateDir = path.join(root, 'candidate');
  const outside = path.join(root, 'escaped.txt');
  try {
    await mkdir(candidateDir, { recursive: true });
    await writeFile(path.join(candidateDir, 'candidate.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(outside)}, 'escaped');\n`);
    const runtime = { runtimeDir: candidateDir, head: 'a'.repeat(40), version: '0.1.0' };
    await assert.rejects(() => validateRuntimeCandidate({ home: root }, runtime), /unavailable until VM Stage 6/u);
    await assert.rejects(readFile(outside), { code: 'ENOENT' });
    assert.deepEqual(candidateValidationAvailability(), {
      state: 'unavailable', ready: false, reason: 'candidate-controlled execution is unavailable until VM Stage 6 restores repository execution',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('static candidate artifact identity is still checked before the unavailable execution boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-candidate-digest-'));
  try {
    await writeFile(path.join(root, 'file.txt'), 'candidate\n');
    const runtime = { runtimeDir: root, head: 'b'.repeat(40), version: '0.1.0' };
    const digest = await runtimeArtifactSha256(root);
    await assert.rejects(() => validateRuntimeCandidate({ home: root }, runtime, null, { expectedArtifactSha256: '0'.repeat(64) }), /candidate artifact changed before validation/u);
    await assert.rejects(() => validateRuntimeCandidate({ home: root }, runtime, null, { expectedArtifactSha256: digest.sha256 }), /unavailable until VM Stage 6/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
