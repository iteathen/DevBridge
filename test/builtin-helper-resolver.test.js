import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveBuiltInHelper } from '../src/app/builtin-helper-resolver.js';
import { builtInToolProfiles } from '../src/runtime/builtin-tool-profiles.js';

test('built-in helper identities resolve to bounded environment-local resources', async () => {
  for (const name of Object.keys(builtInToolProfiles())) {
    const resolved = await resolveBuiltInHelper(name);
    assert.equal(resolved.program, 'node');
    assert.deepEqual(resolved.arguments, []);
    assert.equal(path.isAbsolute(resolved.entry), false);
    assert.ok(resolved.resources.some((resource) => resource.path === resolved.entry));
    assert.ok(resolved.resources.every((resource) => !path.isAbsolute(resource.path) && Buffer.isBuffer(resource.bytes)));
    assert.doesNotMatch(JSON.stringify({ program: resolved.program, arguments: resolved.arguments, entry: resolved.entry, paths: resolved.resources.map((entry) => entry.path) }), /[A-Za-z]:\\|\/Users\/|\/home\//u);
  }
  assert.equal(await resolveBuiltInHelper('unrelated-action'), null);
});
