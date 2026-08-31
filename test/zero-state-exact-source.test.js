import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SOURCE_STAGE_PATH,
  STAGE_PATH,
  parseBootstrapArgs,
  readBootstrapSelection,
  resolveDurableBootstrapSubject,
  runZeroStateBootstrap,
} from '../bootstrap-devbridge.mjs';
import {
  INSTALLED_COMPONENT_FILES,
  SOURCE_REPOSITORY,
  verifyInstalledComponent,
} from '../install-devbridge.mjs';
import { materializeExactSource } from '../src/bootstrap/exact-source-acquisition.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const RAW_BASE = 'https://raw.githubusercontent.com/iteathen/DevBridge/';

function response(body, status = 200) {
  const bytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status === 200,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(bytes.length) : null; } },
    async arrayBuffer() { return bytes; },
  };
}

function repositoryFile(relative) {
  return readFileSync(new URL(`../${relative}`, import.meta.url));
}

function rawRelative(url, head) {
  const prefix = `${RAW_BASE}${head}/`;
  const value = String(url);
  if (!value.startsWith(prefix)) return null;
  return value.slice(prefix.length).split('/').map((segment) => decodeURIComponent(segment)).join('/');
}

function unavailableToolEnvironment(home) {
  const unavailable = path.join(home, 'no-programs');
  return process.platform === 'win32'
    ? { Path: unavailable, PATH: unavailable }
    : { PATH: unavailable };
}

test('exact source acquisition child rejects unsafe topology and removes partial materialization', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-exact-source-lego-'));
  const destination = path.join(root, 'source');
  let requests = 0;
  try {
    await assert.rejects(
      materializeExactSource({
        revision: HEAD_A,
        paths: ['one.mjs', 'nested/two.mjs'],
        destination,
        sourceBase: RAW_BASE,
        async fetcher() {
          requests += 1;
          return requests === 1 ? response('first') : response('interrupted', 503);
        },
      }),
      /Exact source request failed for nested\/two\.mjs with status 503/u,
    );
    assert.equal(existsSync(destination), false);

    await assert.rejects(
      materializeExactSource({
        revision: HEAD_A,
        paths: ['../outside.mjs'],
        destination,
        sourceBase: RAW_BASE,
        async fetcher() { return response('unused'); },
      }),
      /Exact source path is invalid/u,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zero-state branch install is Git-free, resumes the exact subject, and preserves the moving selector', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-zero-state-exact-'));
  let remoteHead = HEAD_A;
  let resolutions = 0;
  let interrupt = true;
  const componentRequests = [];
  const failPath = 'src/entry/experimental-entry.mjs';

  const fetcher = async (url) => {
    const value = String(url);
    if (value.includes('/git/ref/heads/cuda-target')) {
      resolutions += 1;
      return response({ ref: 'refs/heads/cuda-target', object: { sha: remoteHead } });
    }

    for (const head of [HEAD_A, HEAD_B]) {
      const relative = rawRelative(value, head);
      if (relative == null) continue;
      if (relative === STAGE_PATH || relative === SOURCE_STAGE_PATH) {
        return response(repositoryFile(relative));
      }
      if (INSTALLED_COMPONENT_FILES.includes(relative)) {
        componentRequests.push(Object.freeze({ head, relative }));
        if (interrupt && relative === failPath) {
          interrupt = false;
          return response('injected acquisition interruption', 503);
        }
        return response(repositoryFile(relative));
      }
      throw new Error(`unexpected exact-source path ${relative}`);
    }

    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const argv = ['--ref', 'cuda-target', '--install-only', '--home', home];
    const environment = unavailableToolEnvironment(home);

    await assert.rejects(
      runZeroStateBootstrap(argv, { environment, homeDirectory: home, fetcher }),
      new RegExp(`Exact source request failed for ${failPath.replaceAll('.', '\\.')}`, 'u'),
    );
    assert.equal(readBootstrapSelection(home).head, HEAD_A);
    assert.equal(
      existsSync(path.join(home, 'entry', 'components', HEAD_A)),
      false,
    );
    const bootstrapEntries = readdirSync(path.join(home, 'bootstrap'));
    assert.equal(bootstrapEntries.some((name) => name.startsWith('.source-')), false);
    assert.equal(bootstrapEntries.some((name) => name.startsWith('.stage-')), false);

    remoteHead = HEAD_B;
    const result = await runZeroStateBootstrap(argv, { environment, homeDirectory: home, fetcher });

    assert.equal(result.status, 0);
    assert.equal(result.subject.head, HEAD_A);
    assert.equal(result.subject.resumed, true);
    assert.equal(result.installed.componentHead, HEAD_A);
    assert.equal(result.installed.selectedRunnerRef, 'cuda-target');
    assert.equal(result.installed.pinnedRunnerHead, null);
    assert.equal(resolutions, 1);
    assert.equal(readBootstrapSelection(home), null);
    assert.equal(componentRequests.some((request) => request.head === HEAD_B), false);

    const completedPaths = new Set(
      componentRequests
        .filter((request) => request.head === HEAD_A)
        .map((request) => request.relative),
    );
    assert.deepEqual([...completedPaths].sort(), [...INSTALLED_COMPONENT_FILES].sort());

    const component = path.join(home, 'entry', 'components', HEAD_A);
    assert.equal(verifyInstalledComponent(component, HEAD_A, SOURCE_REPOSITORY), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('selection repair separates exact installer mechanics from the exact component subject', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-zero-state-repair-'));
  const requests = [];
  const fetcher = async (url) => {
    const value = String(url);
    requests.push(value);
    const installerRelative = rawRelative(value, HEAD_B);
    if (installerRelative === STAGE_PATH || installerRelative === SOURCE_STAGE_PATH) {
      return response(repositoryFile(installerRelative));
    }
    const componentRelative = rawRelative(value, HEAD_A);
    if (INSTALLED_COMPONENT_FILES.includes(componentRelative)) {
      return response(repositoryFile(componentRelative));
    }
    throw new Error(`unexpected repair fetch ${url}`);
  };

  try {
    const selected = parseBootstrapArgs(['--ref', HEAD_A, '--home', home], { environment: {}, homeDirectory: home });
    await resolveDurableBootstrapSubject(selected, { fetcher });

    const result = await runZeroStateBootstrap([
      '--ref', HEAD_A,
      '--repair-selection-with', HEAD_B,
      '--install-only',
      '--home', home,
    ], {
      environment: unavailableToolEnvironment(home),
      homeDirectory: home,
      fetcher,
    });

    assert.equal(result.subject.head, HEAD_A);
    assert.equal(result.installed.componentHead, HEAD_A);
    assert.equal(readBootstrapSelection(home), null);
    assert.equal(
      verifyInstalledComponent(path.join(home, 'entry', 'components', HEAD_A), HEAD_A, SOURCE_REPOSITORY),
      true,
    );
    assert.equal(requests.some((value) => value.includes(`/${HEAD_A}/${STAGE_PATH}`)), false);
    assert.equal(requests.some((value) => value.includes(`/${HEAD_A}/${SOURCE_STAGE_PATH}`)), false);
    assert.equal(requests.some((value) => value.includes(`/${HEAD_B}/${STAGE_PATH}`)), true);
    assert.equal(requests.some((value) => value.includes(`/${HEAD_B}/${SOURCE_STAGE_PATH}`)), true);
    assert.equal(
      requests.some((value) => INSTALLED_COMPONENT_FILES.some((relative) => value.includes(`/${HEAD_B}/${relative}`))),
      false,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
