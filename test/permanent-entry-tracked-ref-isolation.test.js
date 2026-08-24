import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStableEntry } from '../src/entry/stable-entry.mjs';

const HEAD = 'a'.repeat(40);
const BYTES = Buffer.from('tracked runner\n', 'utf8');
const DIGEST = createHash('sha256').update(BYTES).digest('hex');

test('tracked development refs keep accepted fallback authority isolated by ref', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'devbridge-tracked-ref-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const first = await runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, 'doctor'], {
    env: {},
    homeDirectory: home,
    source: {
      async resolve(ref) { assert.equal(ref, 'cuda-target'); return HEAD; },
      async read(head) { assert.equal(head, HEAD); return BYTES; },
    },
    runnerProvider: {
      async prepare(subject) {
        assert.equal(subject.head, HEAD);
        assert.equal(subject.sha256, DIGEST);
        return { subject, async launch() { return 41; } };
      },
    },
  });
  assert.equal(first, 41);

  await assert.rejects(
    () => runStableEntry(['--entry-development-ref', 'other-target', '--home', home, 'doctor'], {
      env: {},
      homeDirectory: home,
      source: {
        async resolve(ref) { assert.equal(ref, 'other-target'); throw new Error('other ref unavailable'); },
        async read() { throw new Error('must not read unresolved ref'); },
      },
      runnerProvider: {
        async prepare() { throw new Error('other ref must not inherit fallback'); },
      },
    }),
    /other ref unavailable/u,
  );

  const recovered = await runStableEntry(['--entry-development-ref', 'cuda-target', '--home', home, 'doctor'], {
    env: {},
    homeDirectory: home,
    source: {
      async resolve(ref) { assert.equal(ref, 'cuda-target'); throw new Error('refresh unavailable'); },
      async read() { throw new Error('must not read unresolved ref'); },
    },
    runnerProvider: {
      async prepare(subject) {
        assert.equal(subject.head, HEAD);
        assert.equal(subject.sha256, DIGEST);
        return { subject, async launch() { return 42; } };
      },
    },
  });
  assert.equal(recovered, 42);
});
