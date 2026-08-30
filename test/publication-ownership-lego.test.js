import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPublicationFileOwnership } from '../src/install/permanent-entry-installer/publication-file-ownership.mjs';
import { createPublicationTreeOwnership } from '../src/install/permanent-entry-installer/publication-tree-ownership.mjs';

test('publication ownership bricks expose only local port contracts', () => {
  assert.throws(() => createPublicationTreeOwnership(), /configuration/u);
  assert.throws(() => createPublicationFileOwnership(), /configuration/u);
});

test('publication ownership bricks remain free of neighboring topology identities', async () => {
  for (const relative of [
    '../src/install/permanent-entry-installer/publication-tree-ownership.mjs',
    '../src/install/permanent-entry-installer/publication-file-ownership.mjs',
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:entry|wrapper|component|repository|provider|virtual machine|guest|uninstall|quarantine)/iu);
  }
});

test('tree ownership rejects a present descriptor bound to another subject', async () => {
  const state = {
    async read() { return { value: { phase: 'complete', value: { stored: true } } }; },
    async record() {}, async reserve() {}, async complete() {},
  };
  const api = createPublicationTreeOwnership({
    protocol: 'test/tree-v1',
    state,
    artifacts: {
      async observe() { return { state: 'present' }; },
      async discover() { return { current: true }; },
    },
    publication: { verify() { return true; }, publish() {} },
  });
  await assert.rejects(() => api.install({
    identity: 'one', target: '/one', subject: 'subject', endpoint: 'endpoint',
    stagingRoot: '/stage', preservationRoot: '/preserve', obtainSource() {},
  }), /another filesystem subject/u);
});

test('file ownership revalidates generated references after asynchronous state observation', async () => {
  let inspections = 0;
  let writes = 0;
  const absent = { state: 'absent', digest: null, bytes: null, metadata: null };
  const observation = (metadata = null) => ({
    directory: '/files',
    targets: { primary: '/files/primary', previous: '/files/previous', command: '/files/command', shell: '/files/shell' },
    observed: {
      primary: metadata == null ? absent : { state: 'generated', digest: 'a'.repeat(64), bytes: Buffer.from('x'), metadata },
      previous: absent,
      command: absent,
      shell: absent,
    },
  });
  const api = createPublicationFileOwnership({
    protocol: 'test/file-v1',
    state: {
      async read() { return null; },
      async record() { writes += 1; },
      async reserve() { writes += 1; },
      async complete() { writes += 1; },
    },
    artifacts: { async plan() {}, async observe() {} },
    publication: {
      open() {},
      inspect() { inspections += 1; return inspections === 1 ? observation() : observation({ subject: 'changed' }); },
      plan() { throw new Error('plan must not be reached'); },
      apply() { throw new Error('apply must not be reached'); },
    },
    acceptReference() { return false; },
  });
  await assert.rejects(() => api.install({
    root: '/root', subject: 'subject', selection: null,
    identities: { primary: 'one', previous: 'two', command: 'three', shell: 'four' },
  }), /does not reference an accepted subject/u);
  assert.equal(writes, 0);
});
