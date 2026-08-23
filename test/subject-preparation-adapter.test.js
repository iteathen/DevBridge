import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubjectPreparationAdapter } from '../src/app/subject-preparation-adapter.js';

const SUBJECT = `subject-${'7'.repeat(32)}`;

test('subject preparation adapter exposes only the authority subject before resolving physical work', async () => {
  const calls = [];
  const adapter = createSubjectPreparationAdapter({
    async resolve(subject) {
      calls.push(['resolve', subject]);
      return { identity: subject, material: { opaque: true } };
    },
    async apply(request) {
      calls.push(['apply', request]);
      return { identity: request.identity, prepared: true };
    },
  });

  assert.deepEqual(await adapter.prepare({ subject: SUBJECT }), { identity: SUBJECT, prepared: true });
  assert.deepEqual(calls[0], ['resolve', SUBJECT]);
  assert.equal(calls[1][1].material.opaque, true);
});

test('subject preparation adapter rejects topology leakage before resolution', async () => {
  let resolved = false;
  const adapter = createSubjectPreparationAdapter({
    async resolve(subject) { resolved = true; return { identity: subject }; },
    async apply(request) { return { identity: request.identity }; },
  });

  await assert.rejects(
    () => adapter.prepare({ subject: SUBJECT, installer: 'leaked-physical-detail' }),
    /must contain only subject/u,
  );
  assert.equal(resolved, false);
});

test('subject preparation adapter fails closed if resolution or preparation changes subject identity', async () => {
  const changed = `subject-${'8'.repeat(32)}`;
  await assert.rejects(
    () => createSubjectPreparationAdapter({
      async resolve() { return { identity: changed }; },
      async apply(request) { return request; },
    }).prepare({ subject: SUBJECT }),
    /resolution identity changed/u,
  );

  await assert.rejects(
    () => createSubjectPreparationAdapter({
      async resolve(subject) { return { identity: subject }; },
      async apply() { return { identity: changed }; },
    }).prepare({ subject: SUBJECT }),
    /subject preparation identity changed/u,
  );
});