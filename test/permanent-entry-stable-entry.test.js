import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stage0InstallationTag } from '../devbridge.mjs';
import { entryInstallationTag } from '../src/entry/installation-identity.mjs';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';
import { StableRunnerState } from '../src/entry/stable-runner-state.mjs';
import { parseStableEntryArgs, runStableEntry, stableEntryPaths, stableEntryStatus } from '../src/entry/stable-entry.mjs';

const HEAD = '1'.repeat(40);
const BYTES = Buffer.from('stable runner\n', 'utf8');
const DIGEST = createHash('sha256').update(BYTES).digest('hex');

async function homeFixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'devbridge-stable-entry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('entry-owned installation tag remains exactly compatible with the existing installation identity', async (t) => {
  const home = await homeFixture(t);
  assert.equal(await entryInstallationTag(home), stage0InstallationTag(home));
});

test('stable entry consumes only entry-local authority flags and preserves runtime arguments', async (t) => {
  const home = await homeFixture(t);
  const manifest = path.join(home, 'runner-manifest.json');
  const publicKey = path.join(home, 'runner-key.pem');
  const parsed = parseStableEntryArgs([
    '--home', home,
    '--release-mode', 'production',
    '--entry-runner-manifest', manifest,
    '--entry-runner-public-key', publicKey,
    'doctor', '--config', 'local.json',
  ], { env: {}, homeDirectory: home });

  assert.equal(parsed.home, path.resolve(home));
  assert.equal(parsed.releaseMode, 'production');
  assert.equal(parsed.developmentRef, 'main');
  assert.equal(parsed.manifest, path.resolve(manifest));
  assert.equal(parsed.publicKey, path.resolve(publicKey));
  assert.deepEqual(parsed.argv, ['--home', home, '--release-mode', 'production', 'doctor', '--config', 'local.json']);
});

test('tracked development ref is consumed locally and resolves through stable authority', async (t) => {
  const home = await homeFixture(t);
  const calls = [];
  const source = {
    async resolve(ref) { calls.push(['resolve', ref]); return HEAD; },
    async read(head) { calls.push(['read', head]); return BYTES; },
  };
  const status = await runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, 'doctor'], {
    env: {},
    homeDirectory: home,
    source,
    runnerProvider: {
      async prepare(subject) {
        calls.push(['prepare', subject]);
        return {
          subject,
          async launch(argv) { calls.push(['launch', argv]); return 31; },
        };
      },
    },
  });

  assert.equal(status, 31);
  assert.deepEqual(calls[0], ['resolve', 'cuda-target']);
  assert.deepEqual(calls.at(-1), ['launch', ['--home', home, 'doctor']]);
  const accepted = (await stableEntryStatus(home, { developmentRef: 'cuda-target' })).stable;
  assert.equal(accepted.current.mode, 'development');
  assert.equal(accepted.current.subject.head, HEAD);
  assert.equal(accepted.current.subject.sha256, DIGEST);
});

test('tracked development ref preparation failure cannot launch its previous exact subject', async (t) => {
  const home = await homeFixture(t);
  const firstHead = '3'.repeat(40);
  const secondHead = '4'.repeat(40);
  let selectedHead = firstHead;
  const bytes = new Map([
    [firstHead, Buffer.from('first exact runner\n', 'utf8')],
    [secondHead, Buffer.from('second exact runner\n', 'utf8')],
  ]);
  const source = {
    async resolve(ref) { assert.equal(ref, 'cuda-target'); return selectedHead; },
    async read(head) { return bytes.get(head); },
  };
  const acceptingProvider = {
    async prepare(subject) {
      return { subject, async launch() { return 0; } };
    },
  };

  await runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, 'doctor'], {
    env: {}, homeDirectory: home, source, runnerProvider: acceptingProvider,
  });
  selectedHead = secondHead;
  await runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, 'doctor'], {
    env: {}, homeDirectory: home, source, runnerProvider: acceptingProvider,
  });

  const attempts = [];
  await assert.rejects(
    () => runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, 'setup', '--construct'], {
      env: {},
      homeDirectory: home,
      source,
      runnerProvider: {
        async prepare(subject) {
          attempts.push(subject.head);
          throw new Error('current exact checkout receipt mismatch');
        },
      },
    }),
    /current exact checkout receipt mismatch/u,
  );
  assert.deepEqual(attempts, [secondHead]);
});

test('tracked development ref launches its exact control-plane provider instead of Stage 0 accepted-runtime history', async (t) => {
  const home = await homeFixture(t);
  const oldRuntime = '7'.repeat(40);
  const observedRuntime = path.join(home, 'stage0-selected-runtime.txt');
  const runtimeRoot = path.join(home, 'runtime');
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, 'accepted-head.txt'), `${oldRuntime}\n`);

  const stage0Bytes = Buffer.from([
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const homeIndex = process.argv.indexOf('--home');",
    "const home = process.argv[homeIndex + 1];",
    "const selected = readFileSync(path.join(home, 'runtime', 'accepted-head.txt'), 'utf8');",
    "writeFileSync(path.join(home, 'stage0-selected-runtime.txt'), selected);",
    'process.exitCode = 91;',
    '',
  ].join('\n'));
  const selectedHead = '8'.repeat(40);
  const calls = [];

  const status = await runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, 'setup'], {
    env: {},
    homeDirectory: home,
    source: {
      async resolve(ref) { assert.equal(ref, 'cuda-target'); return selectedHead; },
      async read(head) { assert.equal(head, selectedHead); return stage0Bytes; },
    },
    runnerProviders: {
      development: {
        async prepare(subject) {
          calls.push(['prepare', subject.head]);
          return {
            subject,
            async launch(argv) { calls.push(['launch', argv]); return 43; },
          };
        },
      },
      production: {
        async prepare() { throw new Error('development invocation must not use production runner provider'); },
      },
    },
  });

  assert.equal(status, 43);
  assert.deepEqual(calls, [
    ['prepare', selectedHead],
    ['launch', ['--home', home, 'setup']],
  ]);
  await assert.rejects(() => access(observedRuntime), { code: 'ENOENT' });
});

test('development stable entry defaults to main when no tracked ref is supplied', async (t) => {
  const home = await homeFixture(t);
  const calls = [];
  const status = await runStableEntry(['--home', home, 'doctor'], {
    env: {},
    homeDirectory: home,
    source: {
      async resolve(ref) { calls.push(ref); return HEAD; },
      async read() { return BYTES; },
    },
    runnerProvider: {
      async prepare(subject) {
        return { subject, async launch() { return 32; } };
      },
    },
  });
  assert.equal(status, 32);
  assert.deepEqual(calls, ['main']);
});

test('--no-update uses only already accepted mode-matched authority', async (t) => {
  const home = await homeFixture(t);
  const paths = stableEntryPaths(home);
  const state = new StableRunnerState({ stateRoot: paths.stateRoot });
  const accepted = {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head: '2'.repeat(40),
    sha256: 'a'.repeat(64),
    minimumEntryProtocol: 1,
    channel: 'stable',
    releaseId: 'development-two',
  };
  await state.accept({
    subject: accepted,
    mode: 'development',
    sequence: null,
    manifestSha256: null,
    keyId: null,
    acceptedAt: '2026-08-22T12:00:00.000Z',
  });
  let sourceCalls = 0;
  const status = await runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, '--no-update', 'doctor'], {
    env: {},
    homeDirectory: home,
    state,
    source: {
      async resolve() { sourceCalls += 1; throw new Error('must not resolve'); },
      async read() { sourceCalls += 1; throw new Error('must not read'); },
    },
    runnerProvider: {
      async prepare(subject) {
        assert.deepEqual(subject, accepted);
        return { subject, async launch() { return 37; } };
      },
    },
  });
  assert.equal(status, 37);
  assert.equal(sourceCalls, 0);
});

test('entry-status returns path-free installation and stable runner evidence without loading a runner', async (t) => {
  const home = await homeFixture(t);
  const output = [];
  const status = await runStableEntry(['entry-status'], {
    env: { DEVBRIDGE_HOME: home },
    homeDirectory: home,
    source: {
      async resolve() { throw new Error('status must not resolve source'); },
      async read() { throw new Error('status must not read source'); },
    },
    runnerProvider: {
      async prepare() { throw new Error('status must not prepare runner'); },
    },
    write(text) { output.push(text); },
  });

  assert.equal(status, 0);
  const observed = JSON.parse(output.join(''));
  assert.equal(observed.protocol, 'devbridge/entry-status-v1');
  assert.match(observed.installationTag, /^DB-[0-9A-F]{12}$/u);
  assert.equal(observed.stable.configured, false);
  assert.equal(JSON.stringify(observed).includes(home), false);
});

test('development mode rejects production signing inputs instead of silently ignoring them', async (t) => {
  const home = await homeFixture(t);
  assert.throws(
    () => parseStableEntryArgs(['--entry-runner-manifest', path.join(home, 'manifest.json')], { env: {}, homeDirectory: home }),
    /require --release-mode production/u,
  );
});

test('tracked development ref rejects unsafe values and cannot be mixed into production authority', async (t) => {
  const home = await homeFixture(t);
  assert.throws(
    () => parseStableEntryArgs(['--entry-development-ref', '../other'], { env: {}, homeDirectory: home }),
    /development runner ref is invalid/u,
  );
  assert.throws(
    () => parseStableEntryArgs(['--release-mode', 'production', '--entry-development-ref', 'cuda-target'], { env: {}, homeDirectory: home }),
    /requires development release mode/u,
  );
});
