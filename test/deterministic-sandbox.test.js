import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { deterministicOperationSecurity } from '../src/runtime/deterministic-operation-security.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { createDeterministicSandboxProvider } from '../src/runtime/deterministic-sandbox.js';
import { windowsCreateProcessCommandLine } from '../src/runtime/windows-processcontainer-sandbox.js';

function providerFor(root, options = {}) {
  return createDeterministicSandboxProvider({
    policy: options.policy,
    externalReadRoots: options.externalReadRoots ?? [],
    workspaceRoot: root,
    stateDirectory: options.stateDirectory ?? path.join(root, 'state'),
    env: options.env ?? process.env,
  });
}

function supportedSandboxHost() {
  return process.platform === 'linux' || process.platform === 'win32';
}

function expectedProvider() {
  return process.platform === 'win32' ? 'windows-processcontainer' : 'bubblewrap';
}

function requireOrSkipSandbox(t, status) {
  if (status.verified) return true;
  if (process.env.DEVBRIDGE_REQUIRE_SANDBOX_TEST === '1') {
    assert.fail(`required ${expectedProvider()} boundary verification failed: ${status.reason}`);
  }
  t.skip(`${expectedProvider()} unavailable/unusable on this host: ${status.reason}`);
  return false;
}

test('deterministic operations classify static inspection separately and unknown named operations fail into the sandboxed class', () => {
  assert.deepEqual(deterministicOperationSecurity('node.syntax-check'), {
    executionClass: 'static-inspection',
    repositoryCode: false,
    sandboxRequired: false,
    enforcementRequirement: 'none',
  });
  assert.deepEqual(deterministicOperationSecurity('toolchain.probe'), {
    executionClass: 'control-process',
    repositoryCode: false,
    sandboxRequired: false,
    enforcementRequirement: 'none',
  });
  assert.equal(deterministicOperationSecurity('node.test').sandboxRequired, true);
  assert.equal(deterministicOperationSecurity('cmake.configure').repositoryCode, true);
  assert.equal(deterministicOperationSecurity('future.package-manager.operation').sandboxRequired, true);
});

test('Windows process-container command line preserves structural argv boundaries', () => {
  assert.equal(
    windowsCreateProcessCommandLine(['C:\\Program Files\\nodejs\\node.exe', '-e', 'console.log("hello world")', 'safe&literal']),
    '"C:\\Program Files\\nodejs\\node.exe" -e "console.log(\\"hello world\\")" safe&literal',
  );
  assert.equal(
    windowsCreateProcessCommandLine(['node.exe', 'C:\\path with spaces\\']),
    'node.exe "C:\\path with spaces\\\\"',
  );
  assert.throws(() => windowsCreateProcessCommandLine(['node.exe', 'bad\0arg']), /must not contain NUL/u);
});

test('repository-code execution fails closed before process launch when no verified sandbox provider is configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-sandbox-closed-'));
  try {
    const testPath = path.join(root, 'fixture.test.mjs');
    await writeFile(testPath, "import test from 'node:test'; test('never launched', () => {});\n");
    const registry = createCoreOperationRegistry();
    const runner = new DeterministicProcessRunner({ sourceEnv: { PATH: process.env.PATH ?? '' } });
    await assert.rejects(
      () => registry.execute('node.test', { paths: ['fixture.test.mjs'] }, {
        projectDir: root,
        processRunner: runner,
      }),
      /requires a verified sandbox provider; none is configured/u,
    );

    const syntax = await registry.execute('node.syntax-check', { path: 'fixture.test.mjs' }, {
      projectDir: root,
      processRunner: runner,
    });
    assert.equal(syntax.exitCode, 0);
    assert.equal(syntax.sandbox.required, false);
    assert.equal(syntax.sandbox.executionClass, 'static-inspection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('static Node syntax inspection refuses a project symlink that would escape external-read policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-static-read-boundary-'));
  const projectDir = path.join(root, 'project');
  try {
    await mkdir(projectDir, { recursive: true });
    const outside = path.join(root, 'outside-secret.mjs');
    await writeFile(outside, 'export const secret = 1;\n');
    try {
      await symlink(outside, path.join(projectDir, 'linked.mjs'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`filesystem symlink fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }

    const runner = new DeterministicProcessRunner({ sourceEnv: { PATH: process.env.PATH ?? '' } });
    await assert.rejects(
      () => createCoreOperationRegistry().execute('node.syntax-check', { path: 'linked.mjs' }, {
        projectDir,
        processRunner: runner,
      }),
      /crosses filesystem indirection/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verified OS sandbox denies external read/write, control-state read, network egress, and .git mutation', { timeout: 45_000 }, async (t) => {
  if (!supportedSandboxHost()) {
    t.skip('No repository-code sandbox canary is defined for this host OS.');
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-sandbox-boundary-'));
  const projectDir = path.join(root, 'project');
  const outsideDir = path.join(root, 'outside');
  const stateDirectory = path.join(root, 'state');
  try {
    await mkdir(path.join(projectDir, '.git'), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    const outsideRead = path.join(outsideDir, 'outside-secret.txt');
    const outsideWrite = path.join(outsideDir, 'outside-write.txt');
    const stateRead = path.join(stateDirectory, 'control-state.json');
    const gitConfig = path.join(projectDir, '.git', 'config');
    await writeFile(outsideRead, 'outside-sentinel\n');
    await writeFile(stateRead, 'control-state-sentinel\n');
    await writeFile(gitConfig, 'git-admin-sentinel\n');

    const fixture = `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const outsideRead = ${JSON.stringify(outsideRead)};
const outsideWrite = ${JSON.stringify(outsideWrite)};
const stateRead = ${JSON.stringify(stateRead)};

function denied(action) {
  try { action(); return false; } catch { return true; }
}

function networkDenied() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '1.1.1.1', port: 53 });
    const finish = (deniedResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(deniedResult);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    socket.setTimeout(750, () => finish(true));
  });
}

test('repository code is contained', async () => {
  assert.equal(denied(() => fs.readFileSync(outsideRead)), true);
  assert.equal(denied(() => fs.writeFileSync(outsideWrite, 'escaped')), true);
  assert.equal(denied(() => fs.readFileSync(stateRead)), true);
  assert.equal(denied(() => fs.writeFileSync(path.join(process.cwd(), '.git', 'config'), 'mutated')), true);
  assert.equal(await networkDenied(), true);
  assert.equal(process.env.DEVBRIDGE_GITHUB_TOKEN, undefined);
  fs.writeFileSync(path.join(process.cwd(), 'sandbox-project-write.txt'), 'project-ok');
});
`;
    await writeFile(path.join(projectDir, 'boundary.test.mjs'), fixture);

    const provider = providerFor(root, {
      stateDirectory,
      policy: { provider: 'auto', bubblewrapExecutable: 'bwrap' },
      env: { ...process.env, DEVBRIDGE_GITHUB_TOKEN: 'must-not-reach-worker' },
    });
    const status = await provider.verify();
    if (!requireOrSkipSandbox(t, status)) return;

    const runner = new DeterministicProcessRunner({
      sourceEnv: { ...process.env, DEVBRIDGE_GITHUB_TOKEN: 'must-not-reach-worker' },
      sandboxProvider: provider,
    });
    const result = await createCoreOperationRegistry().execute('node.test', { paths: ['boundary.test.mjs'] }, {
      projectDir,
      processRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.sandbox.required, true);
    assert.equal(result.sandbox.provider, expectedProvider());
    assert.equal(result.sandbox.verified, true);
    assert.equal(result.sandbox.network, 'denied');
    assert.equal(await readFile(gitConfig, 'utf8'), 'git-admin-sentinel\n');
    assert.equal(await readFile(stateRead, 'utf8'), 'control-state-sentinel\n');
    await assert.rejects(readFile(outsideWrite), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(projectDir, 'sandbox-project-write.txt'), 'utf8'), 'project-ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verified OS sandbox exposes configured external read roots read-only', { timeout: 45_000 }, async (t) => {
  if (!supportedSandboxHost()) {
    t.skip('No repository-code sandbox canary is defined for this host OS.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-sandbox-readroot-'));
  const projectDir = path.join(root, 'project');
  const readRoot = path.join(root, 'reference');
  const stateDirectory = path.join(root, 'state');
  try {
    await mkdir(path.join(projectDir, '.git'), { recursive: true });
    await mkdir(readRoot, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(projectDir, '.git', 'config'), 'git-admin-sentinel\n');
    await writeFile(path.join(readRoot, 'reference.txt'), 'reference-ok\n');
    const fixture = `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const reference = ${JSON.stringify(path.join(readRoot, 'reference.txt'))};
test('configured read root', () => {
  assert.equal(fs.readFileSync(reference, 'utf8'), 'reference-ok\\n');
  assert.throws(() => fs.writeFileSync(reference, 'mutated'));
});
`;
    await writeFile(path.join(projectDir, 'readroot.test.mjs'), fixture);
    const provider = providerFor(root, {
      stateDirectory,
      externalReadRoots: [readRoot],
      policy: { provider: 'auto', bubblewrapExecutable: 'bwrap' },
    });
    const status = await provider.verify();
    if (!requireOrSkipSandbox(t, status)) return;
    const runner = new DeterministicProcessRunner({ sandboxProvider: provider });
    const result = await createCoreOperationRegistry().execute('node.test', { paths: ['readroot.test.mjs'] }, {
      projectDir,
      processRunner: runner,
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.sandbox.provider, expectedProvider());
    assert.equal(await readFile(path.join(readRoot, 'reference.txt'), 'utf8'), 'reference-ok\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
