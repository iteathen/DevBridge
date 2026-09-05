import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

test('real Git index replacement receives a new exact receipt generation without refetch or old-receipt mutation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'src'), { recursive: true });
  const bytes = Buffer.from('runner\n');
  await writeFile(path.join(source, 'devbridge.mjs'), bytes);
  await writeFile(path.join(source, 'src', 'cli.js'), 'process.exitCode = 0;\n');
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', source, ...args], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-config'), GIT_OPTIONAL_LOCKS: '0' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const exact = subject(head, bytes);
  let acquisitions = 0;
  let launched = 0;
  const make = () => new ExperimentalCheckoutRunnerProvider({
    ...cachePorts(root),
    source: { async materialize({ destination }) { acquisitions += 1; await cp(source, destination, { recursive: true }); } },
    launch() { launched += 1; return 0; },
  });
  await make().prepare(exact);
  const ports = cachePorts(root);
  const checkout = path.join(ports.cacheRoot, 'checkouts', (await readdir(path.join(ports.cacheRoot, 'checkouts')))[0]);
  const inventory = createRunnerCacheInventory({ home: root });
  const oldInventory = await inventory.snapshot();
  const oldItem = oldInventory.items.find((item) => item.identity.startsWith('cache.checkout.'));
  const manifest = await ports.artifacts.discover({ identity: 'probe', root: checkout });
  const receiptFiles = path.join(root, 'entry', 'state', 'cache-ownership-receipts');
  const history = await Promise.all((await readdir(receiptFiles)).map(async (name) => ({ name, bytes: await readFile(path.join(receiptFiles, name)) })));
  const index = path.join(checkout, '.git', 'index');
  const beforeIndex = await lstat(index, { bigint: true });
  const indexBytes = await readFile(index);
  const replacement = path.join(root, 'index-replacement');
  await writeFile(replacement, indexBytes);
  await rename(replacement, index);
  assert.notEqual((await lstat(index, { bigint: true })).ino, beforeIndex.ino);
  assert.equal((await ports.artifacts.observe(manifest)).state, 'ambiguous');
  // A separate owner instance must not recover while another cache activity is live.
  await ports.ownership.duringActivity(async () => {
    await assert.rejects(() => make().prepare(exact), /protected activity is active/u);
    assert.equal((await readdir(receiptFiles)).length, history.length);
  });
  const prepared = await make().prepare(exact);
  assert.notEqual(prepared.recovery.previousOperation, prepared.recovery.operation);
  assert.equal(prepared.recovery.kind, 'byte-identical-files');
  assert.equal(await prepared.launch([]), 0);
  assert.equal(launched, 1);
  assert.equal(acquisitions, 1);
  assert.equal((await ports.artifacts.observe(manifest)).state, 'ambiguous');
  for (const entry of history) assert.deepEqual(await readFile(path.join(receiptFiles, entry.name)), entry.bytes);
  assert.equal((await readdir(receiptFiles)).length, history.length + 1);
  await assert.rejects(() => inventory.bind({
    protocol: 'test/removal-v1', item: oldItem.identity,
    mode: 'application', planDigest: 'd'.repeat(64), effect: oldItem.effects[0],
  }), /changed before acceptance/u);
  const newInventory = await inventory.snapshot();
  assert.notEqual(newInventory.generation, oldInventory.generation);
  assert.deepEqual(newInventory.coverage, ['application']);
  assert.equal(newInventory.mutationActive, false);
  const again = await make().prepare(exact);
  assert.equal(again.recovery, null);
  assert.equal((await readdir(receiptFiles)).length, history.length + 1);
});

test('recovery refuses different bytes without changing receipts and can retry after exact content restoration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-rejected-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const bytes = Buffer.from('runner');
  const git = fakeGit({ head, artifactBytes: bytes });
  const ports = cachePorts(root);
  const make = () => new ExperimentalCheckoutRunnerProvider({ ...ports, run: git.run, launch() { return 0; } });
  const exact = subject(head, bytes);
  await make().prepare(exact);
  const checkouts = path.join(ports.cacheRoot, 'checkouts');
  const cli = path.join(checkouts, (await readdir(checkouts))[0], 'src', 'cli.js');
  const original = await readFile(cli);
  const receiptRoot = path.join(root, 'entry', 'state', 'cache-ownership-receipts');
  const before = await readdir(receiptRoot);
  await writeFile(cli, Buffer.alloc(original.length, 120));
  await assert.rejects(() => make().prepare(exact), /digest/u);
  assert.deepEqual(await readdir(receiptRoot), before);
  assert.equal(ports.ownership.observe().active, false);
  await writeFile(cli, original);
  assert.equal((await make().prepare(exact)).recovery.kind, 'byte-identical-files');
  assert.equal(fetchCalls(git.calls).length, 1);
});

test('receipt replacement failure before or after publication reconciles on a fresh provider', async (t) => {
  for (const failure of ['before', 'after']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'db-entry-checkout-interrupted-recovery-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const head = 'b'.repeat(40);
    const bytes = Buffer.from('runner');
    const git = fakeGit({ head, artifactBytes: bytes });
    const ports = cachePorts(root);
    const normal = () => new ExperimentalCheckoutRunnerProvider({ ...ports, run: git.run, launch() { return 0; } });
    const exact = subject(head, bytes);
    await normal().prepare(exact);
    const checkouts = path.join(ports.cacheRoot, 'checkouts');
    const cli = path.join(checkouts, (await readdir(checkouts))[0], 'src', 'cli.js');
    const replacement = path.join(root, 'replacement');
    await writeFile(replacement, await readFile(cli));
    await rename(replacement, cli);
    const receiptRoot = path.join(root, 'entry', 'state', 'cache-ownership-receipts');
    const count = (await readdir(receiptRoot)).length;
    const failing = new ExperimentalCheckoutRunnerProvider({
      ...ports, run: git.run,
      ownership: {
        ...ports.ownership,
        withActivity: (work) => ports.ownership.withActivity((session) => work({
          ...session,
          async replace(input) {
            if (failure === 'after') await session.replace(input);
            throw new Error('injected receipt publication failure');
          },
        })),
      },
    });
    await assert.rejects(() => failing.prepare(exact), /injected/u);
    assert.equal((await readdir(receiptRoot)).length, count + (failure === 'after' ? 1 : 0));
    assert.equal(ports.ownership.observe().active, false);
    const recovered = await normal().prepare(exact);
    assert.equal(recovered.recovery?.kind ?? null, failure === 'before' ? 'byte-identical-files' : null);
    assert.equal((await readdir(receiptRoot)).length, count + 1);
    assert.equal(fetchCalls(git.calls).length, 1);
  }
});

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
