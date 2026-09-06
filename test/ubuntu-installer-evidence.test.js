import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.match(artifact.initialize[2], /\/bin\/sh \/run\/devbridge-installer-evidence\/agent initialize\n/u);
  assert.deepEqual(artifact.error, ['/bin/sh', artifact.file.path, 'error']);
  assert.deepEqual(artifact.finish, ['/bin/sh', artifact.file.path, 'finish']);
  assert.deepEqual(artifact.wrap('apt-install', ['curtin', 'in-target']), ['/bin/sh', artifact.file.path, 'run', 'apt-install', 'curtin', 'in-target']);
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

test('generated installer hooks retain command failure when the agent cannot execute directly', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-installer-evidence-permissions-'));
  try {
    const artifact = createUbuntuInstallerEvidence(subject);
    const invoke = (command, input = '') => {
      const [executable, ...args] = command.map(part => part.replaceAll('/run/devbridge-installer-evidence', root));
      const result = spawnSync(executable, args, { input, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
      assert.equal(result.error, undefined, result.error?.message);
      return result;
    };
    assert.equal(invoke(artifact.initialize).status, 0);
    // Every Linux runner can enforce this execution denial without requiring
    // a particular mount policy or privileged mount operation. The actual
    // installer's noexec initialization is covered by physical qualification.
    await chmod(path.join(root, 'agent'), 0o600);
    const denied = spawnSync(path.join(root, 'agent'), ['initialize']);
    assert.equal(denied.error?.code, 'EACCES');
    assert.equal(invoke(artifact.wrap('apt-install', ['/bin/sh', '-c', 'exit 100'])).status, 100);
    const saved = await readFile(path.join(root, 'record'));
    assert.equal(invoke(artifact.error).status, 0);
    assert.equal(invoke(artifact.finish).status, 1);
    assert.deepEqual(await readFile(path.join(root, 'record')), saved);
    const response = invoke(['/bin/sh', artifact.file.path, 'serve'], 'S');
    assert.equal(response.status, 0);
    assert.equal(decodeInstallerEvidence(Buffer.from(response.stdout), binding).exitCode, 100);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test('installer observation preserves caller tool lookup and umask without exposing bookkeeping to that path', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-installer-command-environment-'));
  try {
    const agent = path.join(root, 'agent');
    const tools = path.join(root, 'installer-tools');
    const created = path.join(root, 'created-by-command');
    await mkdir(tools);
    await writeFile(agent, createUbuntuInstallerEvidence(subject).file.content, { mode: 0o600 });
    await writeFile(path.join(tools, 'installer-tool'), '#!/bin/sh\nprintf "%s\\n" "$PATH" "$1" "$INSTALLER_TEST_VALUE"\numask\n: >"$2"\nexit "$3"\n', { mode: 0o700 });
    for (const name of ['dirname', 'wc', 'mv']) {
      await writeFile(path.join(tools, name), '#!/bin/sh\nprintf "unexpected diagnostic lookup\\n" >&2\nexit 99\n', { mode: 0o700 });
    }
    const callerPath = `${tools}:/usr/bin:/bin`;
    const invoke = (args, input = '') => spawnSync('/bin/sh', ['-c', 'umask 027; exec /bin/sh "$@"', 'test-installer', agent, ...args], {
      input, env: { ...process.env, PATH: callerPath, INSTALLER_TEST_VALUE: 'unchanged' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    assert.equal(invoke(['initialize']).status, 0);
    const success = invoke(['run', 'apt-update', 'installer-tool', 'argument with spaces', created, '0']);
    assert.ifError(success.error);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, `${callerPath}\nargument with spaces\nunchanged\n0027\n`);
    assert.equal((await lstat(created)).mode & 0o777, 0o640);
    const failed = invoke(['run', 'apt-install', 'installer-tool', 'failure', created, '73']);
    assert.equal(failed.status, 73, failed.stderr);
    const report = invoke(['serve'], 'S');
    assert.equal(report.status, 0, report.stderr);
    assert.equal(decodeInstallerEvidence(Buffer.from(report.stdout), binding).exitCode, 73);
    assert.equal((await lstat(path.join(root, 'record'))).mode & 0o777, 0o600);
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
