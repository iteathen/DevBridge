import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProtocolError, PolicyError } from '../src/errors.js';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { createManifestOperationAdapter } from '../src/runtime/local-operation-manifest.js';
import {
  ProjectRelativePathError,
  normalizeProjectRelativePath,
} from '../src/values/project-relative-path.js';

test('project-relative path value owns normalization without caller identities', () => {
  assert.equal(normalizeProjectRelativePath('src/file.js'), 'src/file.js');
  for (const value of ['', '/absolute', 'C:/absolute', '../escape', 'a/../b', '.git/config', '.devbridge/state']) {
    assert.throws(() => normalizeProjectRelativePath(value), ProjectRelativePathError);
  }
  assert.throws(
    () => normalizeProjectRelativePath('../escape'),
    (error) => !/controller|plan|manifest|operation|provider|caller/iu.test(error.message),
  );
});

test('owning boundaries translate path failures to their local error type', async () => {
  assert.throws(
    () => normalizeControllerPlan({ protocol: 'devbridge/controller-plan-v1', files: [{ path: '../escape', content: 'x' }], operations: [], assertions: [] }),
    ProtocolError,
  );
  await assert.rejects(
    createCoreOperationRegistry().execute('node.syntax-check', { path: '../escape' }, {}),
    PolicyError,
  );
  const adapter = createManifestOperationAdapter({
    protocol: 'devbridge/local-operation-manifest-v1',
    operation: 'tool.fixture',
    executable: 'fixture',
    arguments: [{ kind: 'positional', param: 'input', required: true, valueType: 'project-path' }],
    requireAnyParameter: true,
    source: { kind: 'operator' },
  });
  assert.throws(() => adapter.validate({ input: '../escape' }), PolicyError);
});

test('runtime path consumers do not import controller ownership', async () => {
  for (const file of ['src/runtime/deterministic-operation-registry.js', 'src/runtime/local-operation-manifest.js']) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /(?:\.\.\/run\/|controller-plan)/u);
  }
});
