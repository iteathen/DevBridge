import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitBundleCheckout, SOURCE_BUNDLE_REF } from '../src/bootstrap/git-bundle-checkout.mjs';
import { SourceBundleAvailability } from '../src/bootstrap/source-bundle-availability.mjs';
import { SourceBundleMaterialization } from '../src/bootstrap/source-bundle-materialization.mjs';
import { sourceBundleAuthority } from './fixtures/source-bundle-fixture.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

async function realBundle(root) {
  const repository = path.join(root, 'producer');
  const bundle = path.join(root, 'source.bundle');
  await mkdir(path.join(repository, 'src'), { recursive: true });
  await writeFile(path.join(repository, 'package.json'), '{"name":"devbridge","version":"0.1.0"}\n');
  await writeFile(path.join(repository, 'devbridge.mjs'), 'export const fixture = true;\n');
  await writeFile(path.join(repository, 'src', 'cli.js'), 'export const fixture = true;\n');
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Source Fixture']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'fixture']);
  const head = git(repository, ['rev-parse', 'HEAD']).toLowerCase();
  const tree = git(repository, ['rev-parse', 'HEAD^{tree}']).toLowerCase();
  git(repository, ['branch', 'devbridge-source', head]);
  git(repository, ['bundle', 'create', bundle, SOURCE_BUNDLE_REF]);
  const bytes = await readFile(bundle);
  return { bundle, bytes, head, tree };
}

test('source-bundle materialization rechecks authority, acquisition evidence, and checkout evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-bundle-port-'));
  try {
    const object = path.join(root, 'object');
    const destination = path.join(root, 'checkout');
    const fixture = sourceBundleAuthority();
    await writeFile(object, fixture.bundleBytes);
    const seen = [];
    const materialization = new SourceBundleMaterialization({
      acquisition: {
        async ensure(input) {
          seen.push(input);
          return {
            subject: fixture.descriptor.subject,
            descriptorSha256: (await import('../src/runtime/immutable-object-set.js')).immutableObjectSetDigest(fixture.descriptor),
            objects: [{
              name: fixture.descriptor.objects[0].name,
              size: fixture.bundleBytes.length,
              sha256: fixture.objectSha256,
              location: object,
            }],
          };
        },
      },
      checkout: {
        async materialize(input) {
          assert.equal(input.bundle.location, object);
          assert.equal(input.bundle.sha256, fixture.objectSha256);
          return { head: fixture.head, tree: fixture.tree, root: destination };
        },
      },
    });
    const result = await materialization.prepare({ authority: fixture.authority, destination });
    assert.equal(result.head, fixture.head);
    assert.equal(result.tree, fixture.tree);
    assert.equal(result.objectSha256, fixture.objectSha256);
    assert.equal(seen.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source-bundle materialization rejects forged acquisition and checkout evidence before acceptance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-bundle-forged-'));
  try {
    const object = path.join(root, 'object');
    const fixture = sourceBundleAuthority();
    await writeFile(object, fixture.bundleBytes);
    const base = {
      subject: fixture.descriptor.subject,
      descriptorSha256: (await import('../src/runtime/immutable-object-set.js')).immutableObjectSetDigest(fixture.descriptor),
      objects: [{ name: fixture.descriptor.objects[0].name, size: fixture.bundleBytes.length, sha256: fixture.objectSha256, location: object }],
    };
    const checkout = { async materialize() { return { head: fixture.head, tree: fixture.tree, root: path.join(root, 'checkout') }; } };
    await assert.rejects(
      new SourceBundleMaterialization({ acquisition: { async ensure() { return { ...base, subject: 'foreign' }; } }, checkout })
        .prepare({ authority: fixture.authority, destination: path.join(root, 'a') }),
      /descriptor evidence/u,
    );
    await assert.rejects(
      new SourceBundleMaterialization({ acquisition: { async ensure() { return base; } }, checkout: { async materialize() { return { head: 'c'.repeat(40), tree: fixture.tree, root: path.join(root, 'b') }; } } })
        .prepare({ authority: fixture.authority, destination: path.join(root, 'b') }),
      /checkout evidence/u,
    );
    await assert.rejects(
      new SourceBundleMaterialization({ acquisition: { async ensure() { return base; } }, checkout: { async materialize() { return { head: fixture.head, tree: fixture.tree, root: path.join(root, 'foreign') }; } } })
        .prepare({ authority: fixture.authority, destination: path.join(root, 'expected') }),
      /checkout evidence/u,
    );
    await writeFile(object, 'changed');
    await assert.rejects(
      new SourceBundleMaterialization({ acquisition: { async ensure() { return base; } }, checkout })
        .prepare({ authority: fixture.authority, destination: path.join(root, 'c') }),
      /shape|digest/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source-bundle availability exposes only exact-head prepare and checkout studs', async () => {
  const fixture = sourceBundleAuthority();
  const calls = [];
  const availability = new SourceBundleAvailability({
    authority: fixture.authority,
    materialization: {
      async prepare(input) {
        calls.push(input);
        return { head: fixture.head, tree: fixture.tree, root: input.destination };
      },
    },
  });
  const destination = path.resolve('prepared-source-fixture');
  assert.equal((await availability.prepare({ head: fixture.head, destination })).head, fixture.head);
  assert.equal((await availability.materialize({ subject: { head: fixture.head }, destination })).tree, fixture.tree);
  await assert.rejects(
    availability.prepare({ head: 'c'.repeat(40), destination }),
    /does not match/u,
  );
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[0], 'subject'), false);
});

test('Git bundle checkout materializes one self-contained exact ref and proves commit, tree, cleanliness, and shape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-bundle-git-'));
  try {
    const source = await realBundle(root);
    const destination = path.join(root, 'checkout');
    const sha256 = createHash('sha256').update(source.bytes).digest('hex');
    const result = await new GitBundleCheckout().materialize({
      bundle: { location: source.bundle, size: source.bytes.length, sha256 },
      destination,
      head: source.head,
      tree: source.tree,
    });
    assert.equal(result.head, source.head);
    assert.equal(result.tree, source.tree);
    assert.equal(git(destination, ['remote', 'get-url', 'origin']), 'https://github.com/iteathen/DevBridge.git');
    assert.equal(git(destination, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git bundle checkout rejects wrong head, tree, malformed bytes, and existing destinations without residue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-bundle-fail-'));
  try {
    const source = await realBundle(root);
    const digest = createHash('sha256').update(source.bytes).digest('hex');
    const wrongHead = path.join(root, 'wrong-head');
    await assert.rejects(new GitBundleCheckout().materialize({
      bundle: { location: source.bundle, size: source.bytes.length, sha256: digest },
      destination: wrongHead,
      head: 'f'.repeat(40),
      tree: source.tree,
    }), /advertised source/u);
    await assert.rejects(readFile(wrongHead), /ENOENT/u);

    const wrongTree = path.join(root, 'wrong-tree');
    await assert.rejects(new GitBundleCheckout().materialize({
      bundle: { location: source.bundle, size: source.bytes.length, sha256: digest },
      destination: wrongTree,
      head: source.head,
      tree: 'e'.repeat(40),
    }), /tree does not match/u);
    await assert.rejects(readFile(wrongTree), /ENOENT/u);

    const malformed = path.join(root, 'malformed.bundle');
    await writeFile(malformed, 'not a bundle');
    const malformedBytes = await readFile(malformed);
    await assert.rejects(new GitBundleCheckout().materialize({
      bundle: { location: malformed, size: malformedBytes.length, sha256: createHash('sha256').update(malformedBytes).digest('hex') },
      destination: path.join(root, 'malformed-checkout'),
      head: source.head,
      tree: source.tree,
    }), /Git bundle bundle failed/u);

    const existing = path.join(root, 'existing');
    await mkdir(existing);
    await assert.rejects(new GitBundleCheckout().materialize({
      bundle: { location: source.bundle, size: source.bytes.length, sha256: digest },
      destination: existing,
      head: source.head,
      tree: source.tree,
    }), /must not already exist/u);

    const multiple = path.join(root, 'multiple.bundle');
    git(path.join(root, 'producer'), ['branch', 'another-source', source.head]);
    git(path.join(root, 'producer'), ['bundle', 'create', multiple, SOURCE_BUNDLE_REF, 'refs/heads/another-source']);
    const multipleBytes = await readFile(multiple);
    await assert.rejects(new GitBundleCheckout().materialize({
      bundle: {
        location: multiple,
        size: multipleBytes.length,
        sha256: createHash('sha256').update(multipleBytes).digest('hex'),
      },
      destination: path.join(root, 'multiple-checkout'),
      head: source.head,
      tree: source.tree,
    }), /advertised source/u);

    const interrupted = new AbortController();
    interrupted.abort(new Error('fixture interruption'));
    await assert.rejects(new GitBundleCheckout().materialize({
      bundle: { location: source.bundle, size: source.bytes.length, sha256: digest },
      destination: path.join(root, 'interrupted-checkout'),
      head: source.head,
      tree: source.tree,
      signal: interrupted.signal,
    }), /fixture interruption/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git bundle checkout rejects output made dirty during materialization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-bundle-dirty-'));
  try {
    const source = await realBundle(root);
    const destination = path.join(root, 'checkout');
    const bytes = await readFile(source.bundle);
    const checkout = new GitBundleCheckout({
      run(executable, args, options) {
        const result = spawnSync(executable, args, { ...options, encoding: 'utf8' });
        if (result.status === 0 && args.includes('checkout')) writeFileSync(path.join(destination, 'unexpected.txt'), 'dirty');
        return result;
      },
    });
    await assert.rejects(checkout.materialize({
      bundle: { location: source.bundle, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      destination,
      head: source.head,
      tree: source.tree,
    }), /not clean/u);
    await assert.rejects(readFile(destination), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
