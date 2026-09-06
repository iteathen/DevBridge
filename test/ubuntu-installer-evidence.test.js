import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createUbuntuInstallerEvidence, createUbuntuInstallerEvidenceActivation } from '../src/runtime/image-builders/ubuntu-installer-evidence.js';
import { decodeInstallerEvidence } from '../src/runtime/construction-install-evidence.js';

const subject = 'subject-0123456789abcdef0123456789abcdef';
const binding = { subject, providerInstance: 'test-provider', seedSha256: 'a'.repeat(64), attempt: 1 };

test('Ubuntu installer artifact binds the subject and exposes only fixed lifecycle hooks', () => {
  const artifact = createUbuntuInstallerEvidence(subject);
  assert.equal(artifact.file.path, '/run/devbridge-installer-evidence/agent');
  assert.equal(artifact.file.permissions, '0700');
  assert.match(artifact.file.content, new RegExp(subject, 'u'));
  assert.doesNotMatch(artifact.file.content, /\\\$\{|@IDENTITY@|@PROTOCOL@|\b(?:python|node|ssh|eval)\b/u);
  assert.deepEqual(artifact.error, [artifact.file.path, 'error']);
  assert.deepEqual(artifact.wrap('apt-install', ['curtin', 'in-target']), [artifact.file.path, 'run', 'apt-install', 'curtin', 'in-target']);
  assert.throws(() => artifact.wrap('caller-command', ['true']), /invalid/u);
  assert.throws(() => createUbuntuInstallerEvidence(`${subject};id`), /invalid/u);
});

test('installer socket activation accepts only a bounded native port and fixes its process and resource policy', () => {
  for (const port of [null, '12345', 1024, -1, 0xffffffff, 3.5]) assert.throws(() => createUbuntuInstallerEvidenceActivation({ port }), /invalid/u);
  const activation = createUbuntuInstallerEvidenceActivation({ port: 1234567 });
  assert.equal(activation.files.length, 2);
  assert.match(activation.files[0].content, /ListenStream=vsock::1234567\nAccept=yes/u);
  assert.match(activation.files[1].content, /ExecStart=\/bin\/sh \/run\/devbridge-installer-evidence\/agent serve\n/u);
  assert.match(activation.files[1].content, /RuntimeMaxSec=20s\nTimeoutStopSec=1s\nKillMode=control-group/u);
  assert.match(activation.files[1].content, /MemoryMax=64M\nCPUQuota=25%\nTasksMax=16/u);
  assert.doesNotMatch(activation.files.map(file => file.content).join(''), /AF_INET|ssh|node|python|bash -c/u);
});

test('systemd accepts the exact generated socket and service units without starting them', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-installer-units-'));
  try {
    const activation = createUbuntuInstallerEvidenceActivation({ port: 1234567 });
    const files = [];
    for (const file of activation.files) {
      const destination = path.join(root, path.basename(file.path));
      await writeFile(destination, file.content);
      files.push(destination);
    }
    const checked = spawnSync('/usr/bin/systemd-analyze', ['verify', '--man=no', '--generators=no', ...files], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
      env: { ...process.env, SYSTEMD_UNIT_PATH: `${root}:`, SYSTEMD_LOG_LEVEL: 'warning' },
    });
    assert.equal(checked.error, undefined, checked.error?.message);
    assert.equal(checked.status, 0, checked.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Native Ubuntu shell execution is independently required in Linux CI. These
// tests never initialize /run or execute the generated autoinstall commands.
test('live-installer shell preserves exact command failure and serves bounded terminal evidence', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-installer-evidence-'));
  try {
    const artifact = createUbuntuInstallerEvidence(subject);
    const agent = path.join(root, 'agent');
    await writeFile(agent, artifact.file.content, { mode: 0o700 });
    const run = (args, input = '') => {
      const result = spawnSync('/bin/sh', [agent, ...args], { input, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
      assert.equal(result.error, undefined, result.error?.message);
      return result;
    };
    assert.equal(run(['initialize']).status, 0);
    const initial = decodeInstallerEvidence(Buffer.from(run(['serve'], 'S').stdout), binding);
    assert.equal(initial.phase, 'installing');
    const failed = run(['run', 'apt-install', '/bin/sh', '-c', 'printf "dependency conflict\\n" >&2; exit 100']);
    assert.equal(failed.status, 100);
    assert.equal(failed.stderr, 'dependency conflict\n');
    const saved = await readFile(path.join(root, 'record'));
    assert.equal(run(['error']).status, 0);
    assert.equal(run(['finish']).status, 1);
    assert.equal(run(['run', 'apt-update', '/bin/sh', '-c', 'exit 0']).status, 1);
    assert.deepEqual(await readFile(path.join(root, 'record')), saved);
    const terminal = run(['serve'], 'S');
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.ok(Buffer.byteLength(terminal.stdout) < 4096);
    const report = decodeInstallerEvidence(Buffer.from(terminal.stdout), binding);
    assert.equal(report.exitCode, 100);
    assert.equal(report.stage, 'apt-install');
    assert.equal(report.collection, 'unavailable');
    for (const input of ['SS', 'S\n', 'S\0', 'D;id', 'run apt-install false']) assert.equal(run(['serve'], input).status, 64);
    const diagnostic = run(['serve'], 'D');
    assert.equal(diagnostic.status, 0, diagnostic.stderr);
    assert.equal(decodeInstallerEvidence(Buffer.from(diagnostic.stdout), binding).exitCode, 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an earlier installer error keeps unknown exit and successful commands retain their output', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-installer-evidence-early-'));
  try {
    const agent = path.join(root, 'agent');
    await writeFile(agent, createUbuntuInstallerEvidence(subject).file.content, { mode: 0o700 });
    const run = (args, input = '') => spawnSync('/bin/sh', [agent, ...args], { input, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
    assert.equal(run(['initialize']).status, 0);
    const success = run(['run', 'installation-basis', '/bin/sh', '-c', 'printf captured']);
    assert.equal(success.status, 0);
    assert.equal(success.stdout, 'captured');
    assert.equal(run(['error']).status, 0);
    const report = decodeInstallerEvidence(Buffer.from(run(['serve'], 'S').stdout), binding);
    assert.equal(report.phase, 'failed');
    assert.equal(report.stage, 'installation-basis');
    assert.equal(report.exitCode, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
