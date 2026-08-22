import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSelectedEntrySelector,
  loadDefaultEntry,
  loadSelectedEntry,
  runInstalledEntry,
} from '../devbridge-entry.mjs';

test('installed entry leaves the stable path unchanged without an explicit ref selector', async () => {
  for (const argv of [
    ['doctor', '--config', 'local.json'],
    ['--channel', 'stable', 'status'],
    ['--channel', 'testing', 'daemon'],
  ]) {
    const calls = [];
    const status = await runInstalledEntry(argv, {
      defaultEntryLoader: async () => async (received) => { calls.push(['default', received]); return 17; },
      selectedEntryLoader: async () => { throw new Error('selected path must not load'); },
    });
    assert.equal(status, 17);
    assert.deepEqual(calls, [['default', argv]]);
  }
});

test('installed entry recognizes only explicit ref or branch selection and preserves argv for experimental composition', async () => {
  for (const selector of [
    ['--ref', 'fix/157-controller-owned-fixture'],
    ['--branch', 'a'.repeat(40)],
  ]) {
    const argv = [...selector, 'daemon', '--config', 'local.json'];
    const calls = [];
    const status = await runInstalledEntry(argv, {
      defaultEntryLoader: async () => { throw new Error('default path must not load'); },
      selectedEntryLoader: async () => async (forwarded) => { calls.push(['selected', forwarded]); return 23; },
    });
    assert.equal(status, 23);
    assert.deepEqual(calls, [['selected', argv]]);
  }
});

test('installed entry rejects malformed or conflicting local selectors before either route loads', async () => {
  assert.equal(hasSelectedEntrySelector([]), false);
  assert.equal(hasSelectedEntrySelector(['--channel', 'stable']), false);
  assert.equal(hasSelectedEntrySelector(['--ref', 'topic']), true);
  assert.throws(() => hasSelectedEntrySelector(['--ref']), /requires a local selector value/u);
  assert.throws(() => hasSelectedEntrySelector(['--branch', '--channel', 'stable']), /requires a local selector value/u);
  let loads = 0;
  await assert.rejects(
    () => runInstalledEntry(['--ref', 'one', '--branch', 'two'], {
      defaultEntryLoader: async () => { loads += 1; return async () => 0; },
      selectedEntryLoader: async () => { loads += 1; return async () => 0; },
    }),
    /Only one installed-entry selector/u,
  );
  assert.equal(loads, 0);
});

test('explicit selected recovery does not load the evolving default Stage 0 path', async () => {
  let defaultLoads = 0;
  const status = await runInstalledEntry(['--ref', 'fix/157-controller-owned-fixture', 'doctor'], {
    defaultEntryLoader: async () => {
      defaultLoads += 1;
      throw new SyntaxError('simulated incompatible evolving Stage 0');
    },
    selectedEntryLoader: async () => async () => 29,
  });
  assert.equal(status, 29);
  assert.equal(defaultLoads, 0);
});

test('default and selected module loaders resolve separate local entry modules lazily', async () => {
  const observed = [];
  const defaultEntry = async () => 1;
  const selectedEntry = async () => 2;
  assert.equal(await loadDefaultEntry({
    importModuleFn: async (url) => { observed.push(['default', url]); return { bootstrapStage0: defaultEntry }; },
  }), defaultEntry);
  assert.equal(await loadSelectedEntry({
    importModuleFn: async (url) => { observed.push(['selected', url]); return { runExperimentalEntry: selectedEntry }; },
  }), selectedEntry);
  assert.match(observed[0][1], /\/devbridge\.mjs$/u);
  assert.match(observed[1][1], /\/src\/entry\/experimental-entry\.mjs$/u);
  assert.notEqual(observed[0][1], observed[1][1]);
});

test('one route cannot satisfy the other route contract accidentally', async () => {
  await assert.rejects(
    () => loadDefaultEntry({ importModuleFn: async () => ({ runExperimentalEntry: async () => 0 }) }),
    /default entry must be a function/u,
  );
  await assert.rejects(
    () => loadSelectedEntry({ importModuleFn: async () => ({ bootstrapStage0: async () => 0 }) }),
    /selected entry must be a function/u,
  );
});
