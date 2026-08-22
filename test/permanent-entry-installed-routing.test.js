import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  hasSelectedEntrySelector,
  loadSelectedEntry,
  runInstalledEntry,
} from '../devbridge-entry.mjs';
import { runSelectedEntry } from '../src/entry/selected-entry.mjs';

test('installed entry leaves the stable path unchanged without an explicit ref selector', async () => {
  for (const argv of [
    ['doctor', '--config', 'local.json'],
    ['--channel', 'stable', 'status'],
    ['--channel', 'testing', 'daemon'],
  ]) {
    const calls = [];
    const status = await runInstalledEntry(argv, {
      defaultEntry: async (received) => { calls.push(['default', received]); return 17; },
      selectedEntryLoader: async () => { throw new Error('selected path must not load'); },
    });
    assert.equal(status, 17);
    assert.deepEqual(calls, [['default', argv]]);
  }
});

test('installed entry recognizes only explicit ref or branch selection and preserves argv for the selected composition', async () => {
  for (const selector of [
    ['--ref', 'fix/157-controller-owned-fixture'],
    ['--branch', 'a'.repeat(40)],
  ]) {
    const argv = [...selector, 'daemon', '--config', 'local.json'];
    const calls = [];
    const status = await runInstalledEntry(argv, {
      defaultEntry: async () => { throw new Error('default path must not run'); },
      selectedEntryLoader: async (received) => {
        calls.push(['load', received]);
        return async (forwarded) => { calls.push(['selected', forwarded]); return 23; };
      },
    });
    assert.equal(status, 23);
    assert.deepEqual(calls, [['load', argv], ['selected', argv]]);
  }
});

test('installed entry rejects malformed or conflicting local selectors before either path runs', async () => {
  assert.equal(hasSelectedEntrySelector([]), false);
  assert.equal(hasSelectedEntrySelector(['--channel', 'stable']), false);
  assert.equal(hasSelectedEntrySelector(['--ref', 'topic']), true);
  assert.throws(() => hasSelectedEntrySelector(['--ref']), /requires a local selector value/u);
  assert.throws(() => hasSelectedEntrySelector(['--branch', '--channel', 'stable']), /requires a local selector value/u);
  await assert.rejects(
    () => runInstalledEntry(['--ref', 'one', '--branch', 'two'], {
      defaultEntry: async () => 0,
      selectedEntryLoader: async () => async () => 0,
    }),
    /Only one installed-entry selector/u,
  );
});

test('selected-entry loader reads accepted stable runtime state without creating or rewriting it', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-installed-entry-'));
  const accepted = path.join(home, 'accepted-runtime');
  let observedPaths = null;
  let observedUrl = null;
  const target = async () => 29;
  const loaded = await loadSelectedEntry(['--home', home, '--ref', 'fix/157-controller-owned-fixture', 'doctor'], {
    runtimeSelector: async (paths) => {
      observedPaths = paths;
      return { runtime: { runtimeDir: accepted } };
    },
    importModuleFn: async (url) => {
      observedUrl = url;
      return { runSelectedEntry: target };
    },
  });
  assert.equal(loaded, target);
  assert.equal(observedPaths.home, path.resolve(home));
  assert.equal(
    observedUrl,
    pathToFileURL(path.join(accepted, 'src', 'entry', 'selected-entry.mjs')).href,
  );
});

test('selected-entry adapter delegates without changing the caller argv', async () => {
  const argv = ['--ref', 'fix/157-controller-owned-fixture', 'run-once'];
  let observed = null;
  const status = await runSelectedEntry(argv, {
    entry: async (received) => {
      observed = received;
      received.push('mutated');
      return 31;
    },
  });
  assert.equal(status, 31);
  assert.deepEqual(argv, ['--ref', 'fix/157-controller-owned-fixture', 'run-once']);
  assert.deepEqual(observed, ['--ref', 'fix/157-controller-owned-fixture', 'run-once', 'mutated']);
});
