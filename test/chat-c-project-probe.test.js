import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CHAT_C_PROJECT_DIAGNOSTIC_PROFILE,
  chatCProjectDiagnosticProfile
} from '../src/runtime/builtin-tool-profiles.js';
import {
  CHAT_C_PROJECT_RELATIVE,
  runChatCProjectProbe
} from '../src/runtime/chat-c-project-probe.js';
import { validateToolProfile } from '../src/runtime/cli-profile.js';

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('chat-authored C project profile is fixed and model-free', () => {
  const profile = chatCProjectDiagnosticProfile();
  assert.equal(profile.name, CHAT_C_PROJECT_DIAGNOSTIC_PROFILE);
  assert.equal(profile.executable, process.execPath);
  assert.equal(profile.args.length, 1);
  assert.doesNotMatch(profile.args[0], /codex|spark/iu);
  const validated = validateToolProfile(profile.name, profile);
  assert.equal(validated.sandbox.outsideProjectWrite, false);
  assert.equal(validated.sandbox.network, 'deny');
});

test('chat-authored C project materializes, builds, tests, runs deterministically, and cleans build artifacts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-chat-c-project-'));
  try {
    const result = await runChatCProjectProbe({ projectRoot: root, env: process.env });
    if (result.blocker === 'cmake-unavailable' && !process.env.CI) {
      t.skip('CMake is not installed on this developer machine');
      return;
    }
    assert.equal(result.status, 'complete', result.summary);

    const byName = new Map(result.tests.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('materialize')?.status, 'pass');
    assert.equal(byName.get('cmake-configure')?.exitCode, 0);
    assert.equal(byName.get('cmake-build')?.exitCode, 0);
    assert.equal(byName.get('ctest')?.exitCode, 0);
    assert.equal(byName.get('sample-run-first')?.deterministicPeerMatch, true);
    assert.equal(byName.get('sample-run-first')?.goldenObserved, true);
    assert.equal(byName.get('seed-overflow-rejected')?.overflowRejected, true);
    assert.equal(byName.get('unknown-argument-rejected')?.unknownRejected, true);
    assert.equal(byName.get('help')?.helpOk, true);
    assert.equal(byName.get('cleanup')?.buildArtifactsRemoved, true);

    const project = path.join(root, CHAT_C_PROJECT_RELATIVE);
    assert.equal(await exists(path.join(project, 'build')), false);
    assert.equal(await exists(path.join(project, 'src', 'main.c')), true);
    assert.equal(await exists(path.join(project, 'tests', 'test_telemetry.c')), true);
    assert.match(await readFile(path.join(project, 'README.md'), 'utf8'), /HELLO TELEMETRY|Hello Telemetry/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
