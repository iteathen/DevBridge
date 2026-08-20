import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LIFECYCLE_ROUNDTRIP_NONCE,
  LIFECYCLE_TEMP_DIR,
  runLifecycleRoundtripProbe
} from '../src/runtime/lifecycle-roundtrip-probe.js';
import {
  LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE,
  lifecycleRoundtripDiagnosticProfile
} from '../src/runtime/builtin-tool-profiles.js';
import { validateToolProfile } from '../src/runtime/cli-profile.js';

function context() {
  return {
    protocol: 'devbridge/context-v1',
    sequence: 3,
    task: { issueNumber: 77 },
    objective: `Execute lifecycle roundtrip ${LIFECYCLE_ROUNDTRIP_NONCE}.`,
    priorSummary: `Prior chat context carries ${LIFECYCLE_ROUNDTRIP_NONCE}.`
  };
}

test('built-in lifecycle roundtrip profile is fixed and capability-minimal', () => {
  const profile = lifecycleRoundtripDiagnosticProfile();
  assert.equal(profile.name, LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE);
  assert.equal(profile.executable, LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE);
  assert.deepEqual(profile.args, []);
  assert.equal(path.isAbsolute(profile.executable), false);
  assert.deepEqual(profile.environment.pass, []);
  const validated = validateToolProfile(profile.name, profile);
  assert.equal(validated.sandbox.outsideProjectRead, 'deny');
  assert.equal(validated.sandbox.outsideProjectWrite, false);
  assert.equal(validated.sandbox.network, 'deny');
});

test('lifecycle roundtrip creates/runs a generated test and removes every temporary file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lifecycle-roundtrip-'));
  try {
    const result = await runLifecycleRoundtripProbe({ projectRoot: root, context: context(), env: process.env });
    assert.equal(result.status, 'complete', result.summary);
    const byName = new Map(result.tests.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('test-files-created')?.status, 'pass');
    assert.equal(byName.get('generated-test-run')?.exitCode, 0);
    assert.equal(byName.get('generated-test-run')?.markerObserved, true);
    assert.equal(byName.get('generated-test-run')?.scratchArtifactCreated, true);
    assert.equal(byName.get('context-roundtrip-input')?.nonce, LIFECYCLE_ROUNDTRIP_NONCE);
    assert.equal(byName.get('context-roundtrip-input')?.contextSequence, 3);
    assert.equal(byName.get('cleanup')?.status, 'pass');
    assert.equal(byName.get('cleanup')?.tempRootRemoved, true);
    await assert.rejects(() => access(path.join(root, LIFECYCLE_TEMP_DIR)), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lifecycle roundtrip refuses to run if the required context nonce is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lifecycle-roundtrip-bad-'));
  try {
    const bad = context();
    bad.priorSummary = 'wrong context';
    const result = await runLifecycleRoundtripProbe({ projectRoot: root, context: bad, env: process.env });
    assert.equal(result.status, 'failed');
    assert.equal(result.blocker, 'lifecycle-context-mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
