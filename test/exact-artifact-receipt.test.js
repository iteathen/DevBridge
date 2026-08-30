import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createExactArtifactReceiptJournal,
  EXACT_ARTIFACT_RECEIPT_PROTOCOL,
} from '../src/runtime/exact-artifact-receipt.js';

async function fixture(label) {
  const root = await mkdtemp(path.join(tmpdir(), `devbridge-receipt-${label}-`));
  const scratch = path.join(root, 'scratch');
  await mkdir(scratch);
  return Object.freeze({
    root,
    directory: path.join(root, 'journal'),
    scratch,
    journal() {
      return createExactArtifactReceiptJournal({ directory: this.directory, scratch: this.scratch });
    },
  });
}

function items(suffix = 'one') {
  return [
    { identity: 'second', provenance: 'adopted', value: { digest: `digest-${suffix}`, entries: [2, 1] } },
    { identity: 'first', provenance: 'created', value: { root: { z: suffix, a: true } } },
  ];
}

async function accepted(label, values = items()) {
  const selected = await fixture(label);
  const record = await selected.journal().accept(values);
  return Object.freeze({ ...selected, record });
}

test('exact artifact receipts append canonical chained revisions and survive fresh instances', async (t) => {
  const selected = await fixture('normal');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  const firstJournal = selected.journal();
  assert.equal(await firstJournal.read(), null);

  const first = await firstJournal.accept(items());
  assert.equal(first.protocol, EXACT_ARTIFACT_RECEIPT_PROTOCOL);
  assert.equal(first.revision, 1);
  assert.equal(first.previousDigest, null);
  assert.match(first.epoch, /^[0-9a-f-]{36}$/u);
  assert.match(first.generation, /^generation-[0-9a-f]{64}$/u);
  assert.deepEqual(first.items.map((entry) => entry.identity), ['first', 'second']);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items[0].value.root), true);

  const idempotent = await firstJournal.accept([...items()].reverse());
  assert.deepEqual(idempotent, first);
  assert.deepEqual(await readdir(selected.directory), ['000000000001.json']);

  const firstBytes = await readFile(path.join(selected.directory, '000000000001.json'));
  const second = await firstJournal.accept(items('two'));
  assert.equal(second.revision, 2);
  assert.equal(second.epoch, first.epoch);
  assert.equal(second.previousDigest, createHash('sha256').update(firstBytes).digest('hex'));
  assert.notEqual(second.generation, first.generation);
  assert.deepEqual(await selected.journal().read(), second);
  assert.deepEqual(await readdir(selected.directory), ['000000000001.json', '000000000002.json']);
});

test('a truly recreated receipt journal rotates epoch and generation for identical items', async (t) => {
  const selected = await fixture('recreate');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  const first = await selected.journal().accept(items());
  await rm(selected.directory, { recursive: true, force: true });
  const recreated = await selected.journal().accept(items());
  assert.equal(recreated.revision, 1);
  assert.notEqual(recreated.epoch, first.epoch);
  assert.notEqual(recreated.generation, first.generation);
});

test('concurrent journals reconcile identical proposals and serialize different proposals immutably', async (t) => {
  const same = await fixture('concurrent-same');
  const different = await fixture('concurrent-different');
  t.after(async () => {
    await rm(same.root, { recursive: true, force: true });
    await rm(different.root, { recursive: true, force: true });
  });

  const sameResults = await Promise.all([same.journal().accept(items()), same.journal().accept(items())]);
  assert.deepEqual(sameResults[0], sameResults[1]);
  assert.deepEqual(await readdir(same.directory), ['000000000001.json']);

  const differentResults = await Promise.all([
    different.journal().accept(items('left')),
    different.journal().accept(items('right')),
  ]);
  assert.deepEqual(differentResults.map((entry) => entry.revision).sort((left, right) => left - right), [1, 2]);
  assert.equal((await different.journal().read()).revision, 2);
  assert.deepEqual(await readdir(different.directory), ['000000000001.json', '000000000002.json']);
});

test('conditional receipt acceptance binds the exact observed generation', async (t) => {
  const selected = await fixture('conditional');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  const journal = selected.journal();

  const first = await journal.compareAndAccept({ generation: null, items: items('first') });
  assert.equal(first.accepted, true);
  assert.equal(first.record.revision, 1);
  assert.equal(Object.isFrozen(first), true);

  const idempotent = await journal.compareAndAccept({
    generation: first.record.generation,
    items: [...items('first')].reverse(),
  });
  assert.deepEqual(idempotent, first);
  assert.deepEqual(await readdir(selected.directory), ['000000000001.json']);

  const stale = await journal.compareAndAccept({ generation: null, items: items('stale') });
  assert.equal(stale.accepted, false);
  assert.deepEqual(stale.record, first.record);
  assert.deepEqual(await readdir(selected.directory), ['000000000001.json']);

  const second = await selected.journal().compareAndAccept({
    generation: first.record.generation,
    items: items('second'),
  });
  assert.equal(second.accepted, true);
  assert.equal(second.record.revision, 2);
  assert.notEqual(second.record.generation, first.record.generation);
  assert.deepEqual(await journal.read(), second.record);
});

test('conditional receipt contenders preserve the exact winning revision without later overwrite', async (t) => {
  const selected = await fixture('conditional-contention');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  const results = await Promise.all([
    selected.journal().compareAndAccept({ generation: null, items: items('left') }),
    selected.journal().compareAndAccept({ generation: null, items: items('right') }),
  ]);
  assert.deepEqual(results.map((entry) => entry.accepted).sort(), [false, true]);
  assert.equal(results[0].record.revision, 1);
  assert.deepEqual(results[0].record, results[1].record);
  assert.deepEqual(await selected.journal().read(), results[0].record);
  assert.deepEqual(await readdir(selected.directory), ['000000000001.json']);
});

test('conditional receipt input and corrupt history fail closed', async (t) => {
  const selected = await fixture('conditional-invalid');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  const journal = selected.journal();
  await assert.rejects(
    () => journal.compareAndAccept({ generation: 'not-a-generation', items: items() }),
    /comparison\.generation is invalid/u,
  );
  await assert.rejects(
    () => journal.compareAndAccept({ generation: null, items: items(), extra: true }),
    /comparison\.extra is not allowed/u,
  );
  await journal.accept(items());
  await writeFile(path.join(selected.directory, 'foreign.txt'), 'foreign\n');
  await assert.rejects(
    () => journal.compareAndAccept({ generation: null, items: items('other') }),
    /unsupported entry/u,
  );
});

test('receipt readers reject extra, gapped, noncanonical, changed-chain, and hard-linked history', async (t) => {
  await t.test('extra entry', async (nested) => {
    const selected = await accepted('extra');
    nested.after(() => rm(selected.root, { recursive: true, force: true }));
    await writeFile(path.join(selected.directory, 'foreign.txt'), 'foreign\n');
    await assert.rejects(() => selected.journal().read(), /unsupported entry/u);
  });

  await t.test('revision gap', async (nested) => {
    const selected = await accepted('gap');
    nested.after(() => rm(selected.root, { recursive: true, force: true }));
    await rename(
      path.join(selected.directory, '000000000001.json'),
      path.join(selected.directory, '000000000002.json'),
    );
    await assert.rejects(() => selected.journal().read(), /missing or duplicate revision/u);
  });

  await t.test('noncanonical bytes', async (nested) => {
    const selected = await accepted('noncanonical');
    nested.after(() => rm(selected.root, { recursive: true, force: true }));
    const file = path.join(selected.directory, '000000000001.json');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
    await assert.rejects(() => selected.journal().read(), /not canonical/u);
  });

  await t.test('changed chain', async (nested) => {
    const selected = await accepted('chain');
    nested.after(() => rm(selected.root, { recursive: true, force: true }));
    await selected.journal().accept(items('next'));
    const file = path.join(selected.directory, '000000000002.json');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    parsed.previousDigest = '0'.repeat(64);
    const canonical = Object.fromEntries(Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)));
    await writeFile(file, `${JSON.stringify(canonical)}\n`);
    await assert.rejects(() => selected.journal().read(), /previous digest/u);
  });

  await t.test('hard-linked revision', async (nested) => {
    const selected = await accepted('hardlink');
    nested.after(() => rm(selected.root, { recursive: true, force: true }));
    const alias = path.join(selected.root, 'alias.json');
    await link(path.join(selected.directory, '000000000001.json'), alias);
    await assert.rejects(() => selected.journal().read(), /revision file is invalid/u);
    await unlink(alias);
    assert.equal((await selected.journal().read()).revision, 1);
  });

  await t.test('transient publication link settles before acceptance', async (nested) => {
    const selected = await accepted('settling-link');
    nested.after(() => rm(selected.root, { recursive: true, force: true }));
    const alias = path.join(selected.root, 'transient.json');
    await link(path.join(selected.directory, '000000000001.json'), alias);
    const removal = new Promise((resolve, reject) => setTimeout(() => unlink(alias).then(resolve, reject), 15));
    assert.equal((await selected.journal().read()).revision, 1);
    await removal;
  });
});

test('receipt input rejects false provenance, duplicate identity, non-JSON values, and structural overflow', async (t) => {
  const selected = await fixture('invalid');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  const journal = selected.journal();
  await assert.rejects(() => journal.accept([]), /items are invalid/u);
  await assert.rejects(
    () => journal.accept([{ identity: 'foreign', provenance: 'foreign', value: {} }]),
    /provenance is invalid/u,
  );
  await assert.rejects(
    () => journal.accept([
      { identity: 'same', provenance: 'created', value: {} },
      { identity: 'same', provenance: 'adopted', value: {} },
    ]),
    /duplicates/u,
  );
  await assert.rejects(
    () => journal.accept([{ identity: 'date', provenance: 'created', value: { value: new Date() } }]),
    /exact JSON data/u,
  );
  const circular = {};
  circular.self = circular;
  await assert.rejects(
    () => journal.accept([{ identity: 'cycle', provenance: 'created', value: circular }]),
    /exact JSON data/u,
  );
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 70; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  await assert.rejects(
    () => journal.accept([{ identity: 'deep', provenance: 'created', value: deep }]),
    /structural bound/u,
  );
  await assert.rejects(
    () => journal.accept([{
      identity: 'oversized',
      provenance: 'created',
      value: { text: 'x'.repeat((16 * 1024 * 1024) + 1) },
    }]),
    /byte bound/u,
  );
});

test('receipt roots reject indirection and overlapping scratch while preserving uncreated collisions', async (t) => {
  const selected = await fixture('roots');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  assert.throws(
    () => createExactArtifactReceiptJournal({ directory: selected.scratch, scratch: selected.scratch }),
    /must be separate/u,
  );
  assert.throws(
    () => createExactArtifactReceiptJournal({ directory: path.join(selected.root, 'nested'), scratch: selected.root }),
    /must be separate/u,
  );

  const identifiers = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const collision = path.join(selected.scratch, `.exact-receipt-${identifiers[1]}.tmp`);
  await writeFile(collision, 'foreign-sentinel\n');
  const journal = createExactArtifactReceiptJournal({
    directory: selected.directory,
    scratch: selected.scratch,
    identifier: () => identifiers.shift(),
  });
  await assert.rejects(() => journal.accept(items()), (error) => error?.code === 'EEXIST');
  assert.equal(await readFile(collision, 'utf8'), 'foreign-sentinel\n');
});

test('receipt publication removes only its temporary file and retains unrelated scratch content', async (t) => {
  const selected = await fixture('cleanup');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  await writeFile(path.join(selected.scratch, 'sentinel.txt'), 'keep\n');
  await selected.journal().accept(items());
  assert.deepEqual(await readdir(selected.scratch), ['sentinel.txt']);
});

test('receipt journal rejects directory indirection where the platform permits creating it', async (t) => {
  const selected = await fixture('indirection');
  t.after(() => rm(selected.root, { recursive: true, force: true }));
  const actual = path.join(selected.root, 'actual');
  const indirect = path.join(selected.root, 'indirect');
  await mkdir(actual);
  try {
    await symlink(actual, indirect, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const journal = createExactArtifactReceiptJournal({ directory: indirect, scratch: selected.scratch });
  await assert.rejects(() => journal.read(), /real directory|filesystem indirection/u);
});
