import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileStandaloneArtifact } from '../src/bootstrap/standalone-artifact.mjs';
import { createStandaloneSourceLoader } from '../src/bootstrap/standalone-source-loader.mjs';

function graph(sources, overrides = {}) {
  const records = new Map(Object.entries(sources));
  return ({ importer, specifier }) => {
    if (typeof overrides.load === 'function') return overrides.load({ importer, specifier }, records);
    const identity = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    if (!records.has(identity)) throw new Error(`missing test source ${identity}`);
    return { identity, bytes: records.get(identity) };
  };
}

function compile(sources, overrides = {}) {
  return compileStandaloneArtifact({
    entry: { identity: 'source/parent.mjs', bytes: sources['source/parent.mjs'] },
    load: graph(sources, overrides),
    provenance: 'source/parent.mjs',
  });
}

test('standalone artifact embeds a nested shared graph deterministically without local imports', async () => {
  const sources = {
    'source/parent.mjs': "#!/usr/bin/env node\nimport { left } from './left.mjs';\nimport { right } from './right.mjs';\nexport const result = left + right;\n",
    'source/left.mjs': "import { value } from './shared/value.mjs';\nexport const left = value;\n",
    'source/right.mjs': "import { value } from './shared/value.mjs';\nexport const right = value + 1;\n",
    'source/shared/value.mjs': "import path from 'node:path';\nexport const value = path.sep.length;\n",
  };
  const first = compile(sources);
  const second = compile(sources);
  assert.deepEqual(first, second);
  const text = first.toString('utf8');
  assert.match(text, /^#!\/usr\/bin\/env node\n\/\/ Generated from source\/parent\.mjs/u);
  assert.doesNotMatch(text, /(?:from\s*|import\s*)['"]\.{1,2}\//u);
  const body = text.slice(text.indexOf('\n') + 1);
  const module = await import(`data:text/javascript;base64,${Buffer.from(body).toString('base64')}`);
  assert.equal(module.result, 3);
});

test('standalone graph rejects missing, cyclic, conflicting, duplicate, and unsupported imports', () => {
  assert.throws(() => compile({
    'source/parent.mjs': "import './missing.mjs';\n",
  }), /missing test source/u);

  assert.throws(() => compile({
    'source/parent.mjs': "import './child.mjs';\n",
    'source/child.mjs': "import './parent.mjs';\n",
  }), /contains a cycle/u);

  assert.throws(() => compile({
    'source/parent.mjs': "import './first.mjs';\nimport './second.mjs';\n",
    'source/first.mjs': 'export const value = 1;\n',
    'source/second.mjs': 'export const value = 2;\n',
  }, {
    load({ specifier }, records) {
      const selected = specifier === './first.mjs' ? 'source/first.mjs' : 'source/second.mjs';
      return { identity: 'source/shared.mjs', bytes: records.get(selected) };
    },
  }), /conflicting bytes/u);

  assert.throws(() => compile({
    'source/parent.mjs': "import './child.mjs';\nimport { value } from './child.mjs';\n",
    'source/child.mjs': 'export const value = 1;\n',
  }), /duplicate local import/u);

  for (const specifier of ['package-name', 'file:///tmp/child.mjs', 'https://example.invalid/child.mjs', './extensionless']) {
    const pattern = specifier === './extensionless' ? /invalid relative import/u : /unsupported import/u;
    assert.throws(() => compile({
      'source/parent.mjs': `import ${JSON.stringify(specifier)};\n`,
    }), pattern);
  }
});

test('standalone source loader contains reads and rejects escape, missing files, and indirection', (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'devbridge-standalone-source-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'root');
  const nested = path.join(root, 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, 'entry.mjs'), "import '../value.mjs';\n");
  writeFileSync(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(path.join(parent, 'outside.mjs'), 'export const outside = true;\n');
  mkdirSync(path.join(nested, 'directory.mjs'));
  const loader = createStandaloneSourceLoader({ root });

  assert.equal(loader.read('nested/entry.mjs').identity, 'nested/entry.mjs');
  assert.equal(loader.load({ importer: 'nested/entry.mjs', specifier: '../value.mjs' }).identity, 'value.mjs');
  assert.throws(() => loader.load({ importer: 'nested/entry.mjs', specifier: '../../outside.mjs' }), /escaped/u);
  assert.throws(() => loader.read('nested/missing.mjs'), /ENOENT/u);
  assert.throws(() => loader.read('nested/directory.mjs'), /unsupported filesystem shape/u);

  const link = path.join(nested, 'linked.mjs');
  try {
    symlinkSync(path.join(root, 'value.mjs'), link, 'file');
    assert.throws(() => loader.read('nested/linked.mjs'), /unsupported filesystem shape/u);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
  }
});

test('standalone graph compiler remains import-isolated and topology-neutral', () => {
  const source = readFileSync(new URL('../src/bootstrap/standalone-artifact.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfrom\s*['"]/u);
  assert.doesNotMatch(source, /(?:repository|installer|receipt|provider|virtual machine|guest)/iu);
});
