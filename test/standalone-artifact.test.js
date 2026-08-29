import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStandaloneArtifact } from '../src/bootstrap/standalone-artifact.mjs';

test('standalone artifact embeds isolated modules deterministically without local imports', async () => {
  const source = "#!/usr/bin/env node\nimport { value } from './value.mjs';\nexport const result = value + 1;\n";
  const modules = [{
    specifier: './value.mjs',
    bytes: Buffer.from("import path from 'node:path';\nexport const value = path.sep.length;\n"),
  }];
  const first = compileStandaloneArtifact({ source, modules, provenance: 'source/parent.mjs' });
  const second = compileStandaloneArtifact({ source, modules, provenance: 'source/parent.mjs' });
  assert.deepEqual(first, second);
  const text = first.toString('utf8');
  assert.match(text, /^#!\/usr\/bin\/env node\n\/\/ Generated from source\/parent\.mjs/u);
  assert.doesNotMatch(text, /from ['"]\.\/value\.mjs/u);
  const body = text.slice(text.indexOf('\n') + 1);
  const module = await import(`data:text/javascript;base64,${Buffer.from(body).toString('base64')}`);
  assert.equal(module.result, 2);
});

test('standalone artifact rejects sibling imports and incomplete module sets', () => {
  const source = "import { value } from './value.mjs';\nexport { value };\n";
  assert.throws(() => compileStandaloneArtifact({
    source,
    modules: [{ specifier: './value.mjs', bytes: "import './sibling.mjs';\nexport const value = 1;\n" }],
    provenance: 'source/parent.mjs',
  }), /unsupported import/u);
  assert.throws(() => compileStandaloneArtifact({
    source,
    modules: [],
    provenance: 'source/parent.mjs',
  }), /non-empty array/u);
});
