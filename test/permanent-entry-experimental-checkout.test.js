import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DevelopmentCheckoutRunnerProvider } from '../src/entry/development-checkout-runner-provider.mjs';
import { ExperimentalCheckoutRunnerProvider } from '../src/entry/experimental-checkout-runner-provider.mjs';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';
import { createRunnerCacheOwnership } from '../src/entry/runner-cache-ownership.mjs';
import { createRunnerCacheInventory } from '../src/entry/runner-cache-inventory.mjs';
import { createExactArtifactSet } from '../src/runtime/exact-artifact-set.js';
import { createExactDirectory } from '../src/runtime/exact-directory.js';

const fixedRemote = 'https://github.com/iteathen/DevBridge.git';

function subject(head, bytes, overrides = {}) {
  return {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    minimumEntryProtocol: 1,
    channel: 'experimental',
    releaseId: `development-${head}`,
    ...overrides,
  };
}

function fakeGit({
  head,
  artifactBytes,
  committedArtifactBytes = artifactBytes,
  worktreeArtifactBytes = artifactBytes,
  cliBytes = Buffer.from('#!/usr/bin/env node\n'),
  wrongHead = null,
  dirty = () => false,
} = {}) {
  const calls = [];
  const run = async (program, args, context) => {
    calls.push({ program, args: [...args], context });
    assert.equal(program, 'git');
    if (args[0] === 'init') {
      const target = args[2];
      await mkdir(path.join(target, '.git'), { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const target = args[1];
    const command = args[2];
    if (command === 'checkout') {
      await mkdir(path.join(target, 'src'), { recursive: true });
      await writeFile(path.join(target, 'devbridge.mjs'), worktreeArtifactBytes);
      await writeFile(path.join(target, 'src', 'cli.js'), cliBytes);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'rev-parse') return { exitCode: 0, stdout: `${wrongHead ?? head}\n`, stderr: '' };
    if (command === 'status') return { exitCode: 0, stdout: dirty() ? ' M src/cli.js\n' : '', stderr: '' };
    if (command === 'cat-file') return { exitCode: 0, stdout: Buffer.from(committedArtifactBytes).toString('utf8'), stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function fetchCalls(calls) {
  return calls.filter((entry) => entry.args[2] === 'fetch');
}

function cachePorts(root) {
  const reparse = process.platform === 'win32'
    ? { inspectReparse: async (_location, info) => info.isSymbolicLink() }
    : {};
  const directories = createExactDirectory({ platform: process.platform, ...reparse });
  return {
    cacheRoot: path.join(root, 'entry', 'cache'),
    artifacts: createExactArtifactSet({ platform: process.platform, ...reparse }),
    ownership: createRunnerCacheOwnership({ stateRoot: path.join(root, 'entry', 'state'), directories }),
  };
}

test('provider fetches only the exact head from the fixed source and launches the selected control-plane tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-'));
  const previous = process.env.DEVBRIDGE_ENTRY_TEST_VALUE;
  process.env.DEVBRIDGE_ENTRY_TEST_VALUE = 'present';
  try {
    const head = 'a'.repeat(40);
    const bytes = Buffer.from('standalone-runner');
    const exact = subject(head, bytes);
    const git = fakeGit({ head, artifactBytes: bytes });
    const launches = [];
    const provider = new ExperimentalCheckoutRunnerProvider({
      ...cachePorts(root),
      run: git.run,
      launch(entry, argv, context) {
        launches.push({ entry, argv, context });
        return 23;
      },
    });

    const prepared = await provider.prepare(exact);
    assert.equal(await prepared.launch(['doctor', '--config', 'local.json']), 23);
    assert.deepEqual(prepared.subject, exact);

    assert.equal(fetchCalls(git.calls).length, 1);
    assert.deepEqual(fetchCalls(git.calls)[0].args.slice(2), ['fetch', '--no-tags', '--depth', '1', fixedRemote, head]);
    assert.match(launches[0].entry.replaceAll('\\', '/'), /\/src\/cli\.js$/u);
    assert.deepEqual(launches[0].argv, ['doctor', '--config', 'local.json']);
    assert.equal(launches[0].context.env.DEVBRIDGE_ENTRY_TEST_VALUE, 'present');

    const gitEnvironment = fetchCalls(git.calls)[0].context.env;
    assert.equal(gitEnvironment.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(gitEnvironment.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(gitEnvironment.GIT_TERMINAL_PROMPT, '0');
    assert.equal(gitEnvironment.GIT_CONFIG_COUNT, '3');
    assert.equal(gitEnvironment.GIT_CONFIG_KEY_0, 'core.hooksPath');
    assert.equal(gitEnvironment.GIT_CONFIG_VALUE_0, gitEnvironment.GIT_CONFIG_GLOBAL);
    assert.equal(gitEnvironment.GIT_CONFIG_KEY_1, 'core.fsmonitor');
    assert.equal(gitEnvironment.GIT_CONFIG_VALUE_1, 'false');
    assert.equal(gitEnvironment.GIT_CONFIG_KEY_2, 'credential.helper');
    assert.equal(gitEnvironment.GIT_CONFIG_VALUE_2, '');
    assert.equal(gitEnvironment.DEVBRIDGE_ENTRY_TEST_VALUE, undefined);
  } finally {
    if (previous == null) delete process.env.DEVBRIDGE_ENTRY_TEST_VALUE;
    else process.env.DEVBRIDGE_ENTRY_TEST_VALUE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('provider verifies committed runner bytes independently of working-tree text materialization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-eol-'));
  try {
    const head = '0'.repeat(40);
    const committed = Buffer.from('line-one\nline-two\n');
    const materialized = Buffer.from('line-one\r\nline-two\r\n');
    const git = fakeGit({
      head,
      artifactBytes: committed,
      committedArtifactBytes: committed,
      worktreeArtifactBytes: materialized,
    });
    const provider = new ExperimentalCheckoutRunnerProvider({ ...cachePorts(root), run: git.run, launch() { return 0; } });

    await provider.prepare(subject(head, committed));

    const verification = git.calls.find((entry) => entry.args[2] === 'cat-file');
    assert.ok(verification);
    assert.deepEqual(verification.args.slice(2), ['cat-file', 'blob', `${head}:devbridge.mjs`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider keeps transient and accepted checkout names compact and subject-bound', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-path-budget-'));
  try {
    const head = '1'.repeat(40);
    const bytes = Buffer.from('runner');
    const exact = subject(head, bytes);
    const git = fakeGit({ head, artifactBytes: bytes });
    const provider = new ExperimentalCheckoutRunnerProvider({ ...cachePorts(root), run: git.run, launch() { return 0; } });

    await provider.prepare(exact);

    const init = git.calls.find((entry) => entry.args[0] === 'init');
    assert.ok(init);
    const temporary = init.args[2];
    const temporaryName = path.basename(temporary);
    assert.match(temporaryName, /^\.prepare-[0-9a-f-]{36}\.tmp$/u);
    assert.equal(temporaryName.includes(exact.head), false);
    assert.equal(temporaryName.includes(exact.sha256), false);
    assert.ok(temporaryName.length < 64);

    // Verification canonicalizes the published directory with realpath(). On
    // Windows that spelling may differ from the original temp-root spelling
    // (for example 8.3 expansion), so assert the owned basename contract rather
    // than requiring equivalent absolute paths to be byte-identical.
    const accepted = git.calls
      .filter((entry) => entry.args[0] === '-C' && entry.args[1] !== temporary)
      .map((entry) => entry.args[1])
      .find((entry) => /^[0-9a-f]{64}$/u.test(path.basename(entry)));
    assert.ok(accepted);
    assert.equal(path.basename(accepted).includes(exact.head), false);
    assert.equal(path.basename(accepted).includes(exact.sha256), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verified exact checkout is reused without repeating the network fetch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-reuse-'));
  try {
    const head = 'b'.repeat(40);
    const bytes = Buffer.from('runner');
    const git = fakeGit({ head, artifactBytes: bytes });
    const provider = new ExperimentalCheckoutRunnerProvider({ ...cachePorts(root), run: git.run, launch() { return 0; } });
    const exact = subject(head, bytes);
    await provider.prepare(exact);
    await provider.prepare(exact);
    assert.equal(fetchCalls(git.calls).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider rejects a checkout whose exact head or standalone artifact differs from the subject', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-reject-'));
  try {
    const head = 'c'.repeat(40);
    const bytes = Buffer.from('expected');
    const wrongHeadGit = fakeGit({ head, artifactBytes: bytes, wrongHead: 'd'.repeat(40) });
    const wrongHeadProvider = new ExperimentalCheckoutRunnerProvider({ ...cachePorts(path.join(root, 'head')), run: wrongHeadGit.run, launch() { return 0; } });
    await assert.rejects(() => wrongHeadProvider.prepare(subject(head, bytes)), /different exact head/u);

    const wrongBytesGit = fakeGit({ head, artifactBytes: Buffer.from('different') });
    const wrongBytesProvider = new ExperimentalCheckoutRunnerProvider({ ...cachePorts(path.join(root, 'bytes')), run: wrongBytesGit.run, launch() { return 0; } });
    await assert.rejects(() => wrongBytesProvider.prepare(subject(head, bytes)), /artifact digest differs/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepared launch re-verifies cleanliness and exact identity before every execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-drift-'));
  try {
    const head = 'e'.repeat(40);
    const bytes = Buffer.from('runner');
    let dirty = false;
    const git = fakeGit({ head, artifactBytes: bytes, dirty: () => dirty });
    let launches = 0;
    const provider = new ExperimentalCheckoutRunnerProvider({
      ...cachePorts(root),
      run: git.run,
      launch() { launches += 1; return 0; },
    });
    const prepared = await provider.prepare(subject(head, bytes));
    dirty = true;
    await assert.rejects(() => prepared.launch(['status', '--config', 'local.json']), /not clean/u);
    assert.equal(launches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('experimental checkout provider cannot become stable runner authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-stable-'));
  try {
    const head = 'f'.repeat(40);
    const bytes = Buffer.from('runner');
    const git = fakeGit({ head, artifactBytes: bytes });
    const provider = new ExperimentalCheckoutRunnerProvider({ ...cachePorts(root), run: git.run, launch() { return 0; } });
    await assert.rejects(() => provider.prepare(subject(head, bytes, { channel: 'stable' })), /refuses non-experimental authority/u);
    assert.equal(git.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development checkout provider launches the exact stable development control-plane tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-development-'));
  try {
    const head = '9'.repeat(40);
    const bytes = Buffer.from('development-runner');
    const exact = subject(head, bytes, {
      channel: 'stable',
      releaseId: `development-${head}`,
    });
    const git = fakeGit({ head, artifactBytes: bytes });
    const launches = [];
    const provider = new DevelopmentCheckoutRunnerProvider({
      ...cachePorts(root),
      run: git.run,
      launch(entry, argv) {
        launches.push({ entry, argv });
        return 47;
      },
    });

    const prepared = await provider.prepare(exact);
    assert.equal(await prepared.launch(['--home', root, 'setup']), 47);
    assert.equal(fetchCalls(git.calls).length, 1);
    assert.deepEqual(fetchCalls(git.calls)[0].args.slice(2), ['fetch', '--no-tags', '--depth', '1', fixedRemote, head]);
    assert.match(launches[0].entry.replaceAll('\\', '/'), /\/src\/cli\.js$/u);
    assert.deepEqual(launches[0].argv, ['--home', root, 'setup']);
    const fragment = await createRunnerCacheInventory({ home: root }).snapshot();
    assert.deepEqual(fragment.coverage, ['application']);
    assert.equal(fragment.items.some((item) => item.identity.startsWith('cache.checkout.')), true);
    assert.deepEqual(
      fragment.items.find((item) => item.identity === 'cache.directory.control').after,
      ['cache.file.control'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development checkout provider accepts a replaceable exact source materialization port', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-source-port-'));
  try {
    const head = '7'.repeat(40);
    const bytes = Buffer.from('source-port-runner');
    const exact = subject(head, bytes, { channel: 'stable', releaseId: `development-${head}` });
    const git = fakeGit({ head, artifactBytes: bytes });
    const calls = [];
    const provider = new DevelopmentCheckoutRunnerProvider({
      ...cachePorts(root),
      run: git.run,
      source: {
        async materialize({ subject: selected, destination }) {
          calls.push({ selected, destination });
          await mkdir(path.join(destination, '.git'), { recursive: true });
          await mkdir(path.join(destination, 'src'), { recursive: true });
          await writeFile(path.join(destination, 'devbridge.mjs'), bytes);
          await writeFile(path.join(destination, 'src', 'cli.js'), '#!/usr/bin/env node\n');
          return { head, root: destination };
        },
      },
      launch() { return 0; },
    });
    await provider.prepare(exact);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].selected.head, head);
    assert.equal(fetchCalls(git.calls).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development checkout provider refuses production-like subjects and disabled refresh cannot acquire a missing checkout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-development-denial-'));
  try {
    const head = '8'.repeat(40);
    const bytes = Buffer.from('development-runner');
    const git = fakeGit({ head, artifactBytes: bytes });
    const provider = new DevelopmentCheckoutRunnerProvider({
      ...cachePorts(root),
      run: git.run,
      launch() { throw new Error('must not launch'); },
    });
    await assert.rejects(
      () => provider.prepare(subject(head, bytes, { channel: 'stable', releaseId: 'signed-release-42' })),
      /requires exact development authority/u,
    );
    assert.equal(git.calls.length, 0);

    const offline = new DevelopmentCheckoutRunnerProvider({
      ...cachePorts(path.join(root, 'offline')),
      allowFetch: false,
      run: git.run,
      launch() { throw new Error('must not launch'); },
    });
    await assert.rejects(
      () => offline.prepare(subject(head, bytes, { channel: 'stable', releaseId: `development-${head}` })),
      /runner refresh is disabled/u,
    );
    assert.equal(git.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
