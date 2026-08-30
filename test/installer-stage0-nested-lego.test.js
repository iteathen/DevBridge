import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as installerArtifact from '../install-devbridge.mjs';
import * as installerSource from '../src/install/permanent-entry-installer.mjs';
import * as bootstrapArtifact from '../bootstrap-devbridge.mjs';
import * as bootstrapSource from '../src/bootstrap/zero-state-bootstrap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = Object.freeze([
  Object.freeze({
    parent: 'src/install/permanent-entry-installer.mjs',
    directory: 'src/install/permanent-entry-installer',
    children: Object.freeze({
      'input-contract.mjs': 'parseInstallArgs',
      'source-channel.mjs': 'createSourceChannel',
      'component-store.mjs': 'createComponentStore',
      'mutation-lease.mjs': 'createMutationLease',
      'entry-publication.mjs': 'createEntryPublication',
      'continuation.mjs': 'createContinuation',
      'ownership-state.mjs': 'createOwnershipState',
      'publication-tree-ownership.mjs': 'createPublicationTreeOwnership',
      'publication-file-ownership.mjs': 'createPublicationFileOwnership',
    }),
    dependencies: Object.freeze([
      '../runtime/command-invocation.js',
      '../runtime/conditional-item-set.js',
      '../runtime/exact-artifact-receipt.js',
      '../runtime/exact-artifact-set.js',
      '../runtime/providers/windows-filesystem-entry-observer.js',
    ]),
  }),
  Object.freeze({
    parent: 'src/bootstrap/zero-state-bootstrap.mjs',
    directory: 'src/bootstrap/zero-state-bootstrap',
    children: Object.freeze({
      'input-contract.mjs': 'parseBootstrapArgs',
      'selection-state.mjs': 'createSelectionState',
      'source-channel.mjs': 'createSourceChannel',
      'temporary-materialization.mjs': 'createTemporaryMaterialization',
    }),
    dependencies: Object.freeze([]),
  }),
]);

const LOCAL_IMPORT = /(?:\bfrom\s*|(?:^|\n)\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;

test('installer and Stage 0 children import independently and never name siblings', async () => {
  for (const suite of suites) {
    const peerNames = Object.keys(suite.children);
    for (const [name, expectedExport] of Object.entries(suite.children)) {
      const source = readFileSync(path.join(root, suite.directory, name), 'utf8');
      assert.deepEqual([...source.matchAll(LOCAL_IMPORT)].map((match) => match[1]), [], `${name} must not import local topology`);
      for (const peer of peerNames.filter((value) => value !== name)) {
        assert.equal(source.includes(peer), false, `${name} must not name peer ${peer}`);
      }
      const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${encodeURIComponent(`${suite.directory}/${name}`)}`;
      const module = await import(url);
      assert.equal(typeof module[expectedExport], 'function', `${name} must expose its local contract`);
    }
  }
});

test('only composition parents know the complete child topology', () => {
  for (const suite of suites) {
    const source = readFileSync(path.join(root, suite.parent), 'utf8');
    const imports = [...source.matchAll(LOCAL_IMPORT)].map((match) => match[1]).sort();
    const expected = [
      ...Object.keys(suite.children).map((name) => `./${path.basename(suite.directory)}/${name}`),
      ...suite.dependencies,
    ]
      .sort();
    assert.deepEqual(imports, expected);
  }
});

test('generated artifacts preserve the modular parents public surface and input projections', () => {
  assert.deepEqual(Object.keys(installerArtifact).sort(), Object.keys(installerSource).sort());
  assert.deepEqual(Object.keys(bootstrapArtifact).sort(), Object.keys(bootstrapSource).sort());

  const homeDirectory = path.resolve('contract-home');
  const installArgv = ['--install-only', '--ref', 'selected-channel', '--home', path.join(homeDirectory, 'install')];
  assert.deepEqual(
    installerArtifact.parseInstallArgs(installArgv, { environment: {}, homeDirectory }),
    installerSource.parseInstallArgs(installArgv, { environment: {}, homeDirectory }),
  );
  const bootstrapArgv = ['--install-only', '--ref', 'selected-channel', '--home', path.join(homeDirectory, 'bootstrap')];
  assert.deepEqual(
    bootstrapArtifact.parseBootstrapArgs(bootstrapArgv, { environment: {}, homeDirectory }),
    bootstrapSource.parseBootstrapArgs(bootstrapArgv, { environment: {}, homeDirectory }),
  );
});
