import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContentAddressedRunnerProvider } from '../src/entry/content-addressed-runner-provider.mjs';
import { normalizeRunnerSubject, RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';
import { createRunnerCacheOwnership } from '../src/entry/runner-cache-ownership.mjs';
import { createExactArtifactSet } from '../src/runtime/exact-artifact-set.js';
import { createExactDirectory } from '../src/runtime/exact-directory.js';

function subject(head, bytes) {
  return {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    minimumEntryProtocol: 1,
    channel: 'experimental',
    releaseId: `development-${head}`,
  };
}

async function fixture(t, prefix) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cacheRoot = path.join(home, 'cache');
  const reparse = process.platform === 'win32'
    ? { inspectReparse: async (_location, info) => info.isSymbolicLink() }
    : {};
  const directories = createExactDirectory({ platform: process.platform, ...reparse });
  return {
    home,
    cacheRoot,
    artifacts: createExactArtifactSet({ platform: process.platform, ...reparse }),
    ownership: createRunnerCacheOwnership({ stateRoot: path.join(home, 'state'), directories }),
    normalizeSubject: normalizeRunnerSubject,
  };
}

test('provider receipts exact verified bytes once then reuses the content-addressed object', async (t) => {
  const selected = await fixture(t, 'db-entry-cache-');
  const bytes = Buffer.from('runner-object');
  const exact = subject('a'.repeat(40), bytes);
  let reads = 0;
  const launches = [];
  const provider = new ContentAddressedRunnerProvider({
    cacheRoot: selected.cacheRoot,
    ownership: selected.ownership,
    artifacts: selected.artifacts,
    normalizeSubject: selected.normalizeSubject,
    source: { async read(head) { reads += 1; assert.equal(head, exact.head); return bytes; } },
    launch(file, argv) { launches.push({ file, argv }); return 17; },
  });

  const first = await provider.prepare(exact);
  assert.equal(await first.launch(['doctor', '--config', 'local.json']), 17);
  assert.equal(reads, 1);
  assert.deepEqual(launches[0].argv, ['doctor', '--config', 'local.json']);
  assert.deepEqual(await readFile(launches[0].file), bytes);

  const second = await provider.prepare(exact);
  assert.equal(await second.launch([]), 17);
  assert.equal(reads, 1);
  assert.equal(launches[1].file, launches[0].file);
});

test('provider rejects mismatched fetched bytes before committing or launching them', async (t) => {
  const selected = await fixture(t, 'db-entry-mismatch-');
  const expected = Buffer.from('expected');
  const exact = subject('b'.repeat(40), expected);
  let launches = 0;
  const provider = new ContentAddressedRunnerProvider({
    cacheRoot: selected.cacheRoot,
    ownership: selected.ownership,
    artifacts: selected.artifacts,
    normalizeSubject: selected.normalizeSubject,
    source: { async read() { return Buffer.from('different'); } },
    launch() { launches += 1; return 0; },
  });
  await assert.rejects(() => provider.prepare(exact), /do not match the exact subject/u);
  assert.equal(launches, 0);
});

test('provider preserves a corrupt unowned cache object and refuses to replace it', async (t) => {
  const selected = await fixture(t, 'db-entry-corrupt-');
  const bytes = Buffer.from('verified-runner');
  const exact = subject('c'.repeat(40), bytes);
  const objects = path.join(selected.cacheRoot, 'objects');
  await mkdir(objects, { recursive: true });
  const object = path.join(objects, `${exact.sha256}.mjs`);
  await writeFile(object, 'corrupt');
  let reads = 0;
  const provider = new ContentAddressedRunnerProvider({
    cacheRoot: selected.cacheRoot,
    ownership: selected.ownership,
    artifacts: selected.artifacts,
    normalizeSubject: selected.normalizeSubject,
    source: { async read() { reads += 1; return bytes; } },
    launch() { return 0; },
  });
  await assert.rejects(() => provider.prepare(exact), /unowned cache object/u);
  assert.equal(reads, 0);
  assert.equal(await readFile(object, 'utf8'), 'corrupt');
});

test('provider adopts an exact pre-receipt object and never refetches it', async (t) => {
  const selected = await fixture(t, 'db-entry-adopt-');
  const bytes = Buffer.from('adopted-runner');
  const exact = subject('e'.repeat(40), bytes);
  const objects = path.join(selected.cacheRoot, 'objects');
  await mkdir(objects, { recursive: true });
  await writeFile(path.join(objects, `${exact.sha256}.mjs`), bytes);
  let reads = 0;
  const provider = new ContentAddressedRunnerProvider({
    cacheRoot: selected.cacheRoot,
    ownership: selected.ownership,
    artifacts: selected.artifacts,
    normalizeSubject: selected.normalizeSubject,
    source: { async read() { reads += 1; return bytes; } },
    launch() { return 0; },
  });
  await provider.prepare(exact);
  assert.equal(reads, 0);
});

test('provider requires closed local authority ports and closed string argv', async (t) => {
  assert.throws(() => new ContentAddressedRunnerProvider({ source: { read() {} }, cacheRoot: 'relative' }), /absolute local path/u);
  const selected = await fixture(t, 'db-entry-argv-');
  assert.throws(() => new ContentAddressedRunnerProvider({
    source: { read() {} }, cacheRoot: selected.cacheRoot, normalizeSubject: normalizeRunnerSubject,
  }), /ownership/u);
  const bytes = Buffer.from('runner');
  const exact = subject('d'.repeat(40), bytes);
  const provider = new ContentAddressedRunnerProvider({
    cacheRoot: selected.cacheRoot,
    ownership: selected.ownership,
    artifacts: selected.artifacts,
    normalizeSubject: selected.normalizeSubject,
    source: { async read() { return bytes; } },
    launch() { return 0; },
  });
  const prepared = await provider.prepare(exact);
  await assert.rejects(() => prepared.launch(['ok', { path: 'authority' }]), /array of strings/u);
});
