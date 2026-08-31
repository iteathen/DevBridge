import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BOOTSTRAP_PROTOCOL,
  parseBootstrapArgs,
  readBootstrapSelection,
  resolveDurableBootstrapSubject,
  runZeroStateBootstrap,
} from '../bootstrap-devbridge.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function response(body, status = 200) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status === 200,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(bytes.length) : null; } },
    async arrayBuffer() { return bytes; },
  };
}

function subjectPayload(ref, head) {
  return { ref: `refs/heads/${ref}`, object: { sha: head } };
}

function makeHome() {
  return mkdtempSync(path.join(tmpdir(), 'devbridge-zero-state-'));
}

function preparedSource(home) {
  return async (_stage, subject) => Object.freeze({
    head: subject.head,
    root: home,
    cleanup() {},
  });
}

test('bootstrap parser preserves explicit selector intent separately from exact subject', () => {
  const root = path.resolve('bootstrap-home');
  const stable = parseBootstrapArgs(['--home', root], { environment: {}, homeDirectory: root });
  assert.equal(stable.selector.value, 'main');
  assert.equal(stable.explicitSelector, false);
  const development = parseBootstrapArgs(['--ref', 'cuda-target', '--install-only', '--home', root], { environment: {}, homeDirectory: root });
  assert.equal(development.selector.value, 'cuda-target');
  assert.equal(development.explicitSelector, true);
  assert.equal(development.runSetup, false);
  assert.equal(development.repairSelectionWith, null);

  const repair = parseBootstrapArgs([
    '--ref', HEAD_A,
    '--repair-selection-with', HEAD_B,
    '--install-only',
    '--home', root,
  ], { environment: {}, homeDirectory: root });
  assert.equal(repair.selector.value, HEAD_A);
  assert.equal(repair.repairSelectionWith, HEAD_B);
  assert.equal(repair.runSetup, false);
  assert.throws(
    () => parseBootstrapArgs(['--ref', HEAD_A, '--repair-selection-with', 'cuda-target', '--install-only'], { environment: {}, homeDirectory: root }),
    /requires an exact 40-hex head/u,
  );
  assert.throws(
    () => parseBootstrapArgs(['--ref', HEAD_A, '--repair-selection-with', HEAD_B], { environment: {}, homeDirectory: root }),
    /requires --install-only/u,
  );
});

test('interrupted moving selector resumes the persisted exact subject after branch movement', async () => {
  const home = makeHome();
  let remoteHead = HEAD_A;
  let resolutions = 0;
  const fetcher = async (url) => {
    if (String(url).includes('/git/ref/heads/cuda-target')) {
      resolutions += 1;
      return response(subjectPayload('cuda-target', remoteHead));
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const options = parseBootstrapArgs(['--ref', 'cuda-target', '--home', home], { environment: {}, homeDirectory: home });
    const first = await resolveDurableBootstrapSubject(options, { fetcher });
    assert.equal(first.head, HEAD_A);
    assert.equal(first.resumed, false);
    assert.equal(readBootstrapSelection(home).head, HEAD_A);

    remoteHead = HEAD_B;
    const resumed = await resolveDurableBootstrapSubject(options, { fetcher });
    assert.equal(resumed.head, HEAD_A);
    assert.equal(resumed.resumed, true);
    assert.equal(resolutions, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap selection is durable before activation and clears only after permanent-entry commit', async () => {
  const home = makeHome();
  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes('/git/ref/heads/cuda-target')) return response(subjectPayload('cuda-target', HEAD_A));
    if (value.includes(`/${HEAD_A}/install-devbridge.mjs`)) return response('export const placeholder = true;');
    throw new Error(`unexpected fetch ${url}`);
  };
  let observed = null;
  try {
    const result = await runZeroStateBootstrap(['--ref', 'cuda-target', '--install-only', '--home', home], {
      environment: {},
      homeDirectory: home,
      fetcher,
      prepareSource: preparedSource(home),
      async loadStage() {
        return {
          installDevBridge(options) {
            const checkpoint = readBootstrapSelection(home);
            assert.equal(checkpoint.protocol, BOOTSTRAP_PROTOCOL);
            assert.equal(checkpoint.head, HEAD_A);
            observed = options;
            return { home, wrappers: { javascript: path.join(home, 'bin', 'entry.mjs') } };
          },
          runInstalledSetup() { throw new Error('setup must not run'); },
        };
      },
    });
    assert.equal(result.status, 0);
    assert.equal(observed.selector.value, HEAD_A);
    assert.equal(observed.selectedRunnerRef, 'cuda-target');
    assert.equal(Object.hasOwn(observed, 'pinSelectedRunner'), false);
    assert.equal(readBootstrapSelection(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('failed activation retains the exact recovery checkpoint', async () => {
  const home = makeHome();
  let remoteHead = HEAD_A;
  let resolutions = 0;
  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes('/git/ref/heads/cuda-target')) {
      resolutions += 1;
      return response(subjectPayload('cuda-target', remoteHead));
    }
    if (value.includes('/install-devbridge.mjs')) return response('export const placeholder = true;');
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    await assert.rejects(
      runZeroStateBootstrap(['--ref', 'cuda-target', '--home', home], {
        environment: {},
        homeDirectory: home,
        fetcher,
        prepareSource: preparedSource(home),
        async loadStage() {
          return {
            installDevBridge() { throw new Error('injected interruption'); },
            runInstalledSetup() { return 0; },
          };
        },
      }),
      /injected interruption/,
    );
    assert.equal(readBootstrapSelection(home).head, HEAD_A);

    remoteHead = HEAD_B;
    await assert.rejects(
      runZeroStateBootstrap(['--ref', 'cuda-target', '--home', home], {
        environment: {},
        homeDirectory: home,
        fetcher,
        prepareSource: preparedSource(home),
        async loadStage() {
          return {
            installDevBridge(options) {
              assert.equal(options.selector.value, HEAD_A);
              assert.equal(options.selectedRunnerRef, 'cuda-target');
              throw new Error('second injected interruption');
            },
            runInstalledSetup() { return 0; },
          };
        },
      }),
      /second injected interruption/,
    );
    assert.equal(resolutions, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('different selector cannot replace an incomplete bootstrap checkpoint implicitly', async () => {
  const home = makeHome();
  const fetcher = async (url) => {
    if (String(url).includes('/git/ref/heads/cuda-target')) return response(subjectPayload('cuda-target', HEAD_A));
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const first = parseBootstrapArgs(['--ref', 'cuda-target', '--home', home], { environment: {}, homeDirectory: home });
    await resolveDurableBootstrapSubject(first, { fetcher });
    const second = parseBootstrapArgs(['--ref', HEAD_B, '--home', home], { environment: {}, homeDirectory: home });
    await assert.rejects(resolveDurableBootstrapSubject(second, { fetcher }), /already bound to cuda-target/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('explicit repair uses newer exact installer mechanics to commit only the existing durable subject', async () => {
  const home = makeHome();
  const fetched = [];
  let setupCalls = 0;
  try {
    const selected = parseBootstrapArgs(['--ref', HEAD_A, '--home', home], { environment: {}, homeDirectory: home });
    await resolveDurableBootstrapSubject(selected, { fetcher: async () => { throw new Error('exact selection must not resolve remotely'); } });

    const result = await runZeroStateBootstrap([
      '--ref', HEAD_A,
      '--repair-selection-with', HEAD_B,
      '--install-only',
      '--home', home,
    ], {
      environment: {},
      homeDirectory: home,
      async fetcher(url) {
        fetched.push(String(url));
        if (String(url).includes(`/${HEAD_B}/install-devbridge.mjs`)) return response('export const placeholder = true;');
        throw new Error(`unexpected fetch ${url}`);
      },
      async prepareSource(_stage, subject, context) {
        assert.equal(subject.head, HEAD_A);
        assert.equal(context.installerHead, HEAD_B);
        return Object.freeze({ head: HEAD_A, root: home, cleanup() {} });
      },
      async loadStage() {
        return {
          installDevBridge(options, dependencies) {
            assert.equal(readBootstrapSelection(home).head, HEAD_A);
            assert.equal(options.selector.value, HEAD_A);
            assert.equal(options.selectedRunnerRef, HEAD_A);
            assert.equal(dependencies.preparedSource.head, HEAD_A);
            return { componentHead: HEAD_A, home };
          },
          runInstalledSetup() { setupCalls += 1; return 0; },
        };
      },
    });

    assert.equal(result.subject.head, HEAD_A);
    assert.equal(result.installed.componentHead, HEAD_A);
    assert.equal(readBootstrapSelection(home), null);
    assert.equal(setupCalls, 0);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], new RegExp(`/${HEAD_B}/install-devbridge\\.mjs$`, 'u'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('selection repair requires prior state and retains it unless the selected subject commits', async () => {
  const absentHome = makeHome();
  const retainedHome = makeHome();
  try {
    const repairArgv = [
      '--ref', HEAD_A,
      '--repair-selection-with', HEAD_B,
      '--install-only',
    ];
    await assert.rejects(
      runZeroStateBootstrap([...repairArgv, '--home', absentHome], {
        environment: {},
        homeDirectory: absentHome,
        async fetcher() { throw new Error('repair without state must not fetch'); },
      }),
      /requires an existing durable bootstrap selection/u,
    );
    assert.equal(readBootstrapSelection(absentHome), null);

    const selected = parseBootstrapArgs(['--ref', HEAD_A, '--home', retainedHome], { environment: {}, homeDirectory: retainedHome });
    await resolveDurableBootstrapSubject(selected, { fetcher: async () => { throw new Error('exact selection must not resolve remotely'); } });
    await assert.rejects(
      runZeroStateBootstrap([...repairArgv, '--home', retainedHome], {
        environment: {},
        homeDirectory: retainedHome,
        async fetcher(url) {
          if (String(url).includes(`/${HEAD_B}/install-devbridge.mjs`)) return response('export const placeholder = true;');
          throw new Error(`unexpected fetch ${url}`);
        },
        prepareSource: preparedSource(retainedHome),
        async loadStage() {
          return {
            installDevBridge() { return { componentHead: HEAD_B, home: retainedHome }; },
            runInstalledSetup() { throw new Error('setup must not run'); },
          };
        },
      }),
      /did not commit the exact selected subject/u,
    );
    assert.equal(readBootstrapSelection(retainedHome).head, HEAD_A);
  } finally {
    rmSync(absentHome, { recursive: true, force: true });
    rmSync(retainedHome, { recursive: true, force: true });
  }
});

test('standalone first-stage bytes can execute directly from a Node data import', () => {
  const source = readFileSync(new URL('../bootstrap-devbridge.mjs', import.meta.url));
  const data = `data:text/javascript;base64,${source.toString('base64')}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(data)})`, '--', '--help'], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DevBridge zero-state bootstrap/);
  assert.match(result.stdout, /requires only supported Node\.js/);
});
