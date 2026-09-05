import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import {
  LOCAL_OPERATION_MANIFEST_PROTOCOL,
  createManifestOperationAdapter,
  loadLocalOperationManifests,
  validateLocalOperationManifest,
} from '../src/runtime/local-operation-manifest.js';

function fixtureManifest(overrides = {}) {
  return {
    protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
    operation: 'tool.fixture',
    executable: process.execPath,
    arguments: [
      { kind: 'literal', value: 'fixed-subcommand' },
      { kind: 'flag', param: 'verbose', flag: '--verbose' },
      { kind: 'option', param: 'count', flag: '--count', valueType: 'integer' },
      { kind: 'option', param: 'mode', flag: '--mode', valueType: 'enum', values: ['fast', 'safe'] },
      { kind: 'positional', param: 'input', required: true, valueType: 'project-path' },
      { kind: 'positional', param: 'tag', repeat: true, maxItems: 3, valueType: 'string' },
    ],
    timeoutMs: 12_000,
    maxOutputBytes: 16_384,
    requireAnyParameter: true,
    source: { kind: 'operator' },
    ...overrides,
  };
}

test('local manifest materializes closed structural argv behind a logical repository-tool identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-local-op-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const registry = new DeterministicOperationRegistry();
    registry.register('tool.fixture', createManifestOperationAdapter(fixtureManifest()));
    const calls = [];
    const result = await registry.execute('tool.fixture', {
      verbose: true,
      count: 3,
      mode: 'fast',
      input: 'src/file.js',
      tag: ['alpha', 'beta'],
    }, {
      projectDir,
      repository: 'owner/project',
      runId: 'run-1',
      processRunner: {
        run: async (request) => {
          calls.push(request);
          return { exitCode: 0, timedOut: false, stdout: 'ok', stderr: '' };
        },
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].repositoryTool, path.basename(process.execPath));
    assert.deepEqual(calls[0].args, [
      'fixed-subcommand', '--verbose', '--count', '3', '--mode', 'fast',
      'src/file.js', 'alpha', 'beta',
    ]);
    assert.equal(calls[0].cwd, projectDir);
    assert.equal(calls[0].executionClass, 'repository-code');
    assert.equal(calls[0].repository, 'owner/project');
    assert.equal(calls[0].runId, 'run-1');
    assert.equal(Object.hasOwn(calls[0], 'executable'), false);
    assert.equal(Object.hasOwn(calls[0], 'sandbox'), false);
    assert.deepEqual(calls[0].environment, { pass: [], set: { CI: '1' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('help-synthesized manifest uses its command as the repository tool identity', async () => {
  const calls = [];
  const manifest = fixtureManifest({
    executable: '/operator/local/path/magic-tool',
    source: { kind: 'help-synthesized', command: 'magic-tool', helpSha256: 'a'.repeat(64) },
  });
  const registry = new DeterministicOperationRegistry().register('tool.fixture', createManifestOperationAdapter(manifest));
  await registry.execute('tool.fixture', { input: 'src/file.js' }, {
    projectDir: '/project',
    repository: 'owner/project',
    runId: 'run-1',
    processRunner: { run: async (request) => { calls.push(request); return { exitCode: 0 }; } },
  });
  assert.equal(calls[0].repositoryTool, 'magic-tool');
  assert.doesNotMatch(JSON.stringify(calls[0]), /operator\/local\/path/u);
});

test('dynamic manifest parameters reject authority-shaped names and argv/path smuggling', () => {
  const authority = fixtureManifest({
    arguments: [{ kind: 'option', param: 'env', flag: '--env', valueType: 'string' }],
  });
  assert.throws(() => validateLocalOperationManifest(authority), /reserved for control-plane authority/u);

  const adapter = createManifestOperationAdapter(fixtureManifest());
  assert.throws(() => adapter.validate({ input: 'src/file.js', unknown: 'x' }), /parameter unknown is not allowed/u);
  assert.throws(() => adapter.validate({ input: '../escape.js' }), /must not traverse/u);
  assert.throws(() => adapter.validate({ input: 'src/file.js', tag: ['-raw-argv'] }), /must not begin with '-'/u);
  assert.throws(() => adapter.validate({ input: 'src/file.js', tag: ['/absolute'] }), /absolute path-shaped/u);
  assert.throws(() => adapter.validate({ input: 'src/file.js', mode: 'unsafe' }), /allowed enum/u);
  assert.throws(() => adapter.validate({}), /input is required/u);
});

test('requireAnyParameter prevents a generated wrapper from invoking an empty default behavior', () => {
  const adapter = createManifestOperationAdapter(fixtureManifest({
    arguments: [{ kind: 'flag', param: 'verbose', flag: '--verbose' }],
  }));
  assert.throws(() => adapter.validate({}), /requires at least one bounded parameter/u);
  assert.throws(() => adapter.validate({ verbose: false }), /requires at least one bounded parameter/u);
  assert.deepEqual(adapter.validate({ verbose: true }), { verbose: true });
});

test('operator manifests can declare long bounded qualification timeouts', () => {
  const manifest = validateLocalOperationManifest(fixtureManifest({
    timeoutMs: 1_800_000,
    requireAnyParameter: false,
  }));
  assert.equal(manifest.timeoutMs, 1_800_000);
  assert.throws(() => validateLocalOperationManifest(fixtureManifest({ timeoutMs: 28_800_001 })), /timeoutMs/u);
});

test('local manifest directory loading is deterministic and collisions fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-local-manifests-'));
  try {
    const first = fixtureManifest({ operation: 'tool.alpha' });
    const second = fixtureManifest({ operation: 'tool.beta' });
    await writeFile(path.join(root, '10-alpha.json'), `${JSON.stringify(first)}\n`, { mode: 0o600 });
    await writeFile(path.join(root, '20-beta.json'), `${JSON.stringify(second)}\n`, { mode: 0o600 });
    const registry = new DeterministicOperationRegistry();
    const loaded = await loadLocalOperationManifests({ directory: root, registry });
    assert.deepEqual(loaded.map((entry) => entry.operation), ['tool.alpha', 'tool.beta']);
    const described = registry.describe();
    assert.deepEqual(described.map(({ name, layer }) => ({ name, layer })), [
      { name: 'tool.alpha', layer: 'local-manifest' },
      { name: 'tool.beta', layer: 'local-manifest' },
    ]);
    for (const entry of described) {
      assert.equal(entry.parameterSchema.protocol, 'devbridge/operation-parameters-v1');
      assert.equal(entry.parameterSchema.requireAnyParameter, true);
      assert.equal(entry.parameterSchema.parameters.some((parameter) => parameter.name === 'input' && parameter.required === true), true);
      assert.equal(JSON.stringify(entry.parameterSchema).includes('--verbose'), false);
      assert.equal(JSON.stringify(entry.parameterSchema).includes('fixed-subcommand'), false);
    }

    await writeFile(path.join(root, '30-duplicate.json'), `${JSON.stringify(first)}\n`, { mode: 0o600 });
    await assert.rejects(
      loadLocalOperationManifests({ directory: root, registry: new DeterministicOperationRegistry() }),
      /already exists/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local manifest directory rejects filesystem indirection in its parent chain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-local-manifest-indirection-'));
  const actualParent = path.join(root, 'actual');
  const manifestRoot = path.join(actualParent, 'manifests');
  const aliasParent = path.join(root, 'alias');
  await mkdir(manifestRoot, { recursive: true });
  await symlink(actualParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(
      loadLocalOperationManifests({
        directory: path.join(aliasParent, 'manifests'),
        registry: new DeterministicOperationRegistry(),
      }),
      /must not use filesystem indirection/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
