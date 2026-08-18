import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  LocalToolchainRegistry,
  createCoreToolchainRegistry,
} from '../src/runtime/toolchain-registry.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';

test('core toolchain registry exposes locally resolved Node, CMake, CTest, compiler, and linker names', () => {
  const registry = createCoreToolchainRegistry({ env: { PATH: '' } });
  assert.deepEqual(registry.names(), ['cmake', 'ctest', 'native.c', 'native.linker', 'node']);
});

test('local toolchain registry caches approved resolvers and reports unavailable tools without inventing authority', async () => {
  let calls = 0;
  const registry = new LocalToolchainRegistry()
    .register('fixture', async () => {
      calls += 1;
      return { executable: process.execPath, family: 'fixture', version: '1' };
    })
    .register('missing', async () => { throw new Error('not installed'); });
  assert.equal((await registry.resolve('fixture')).executable, process.execPath);
  assert.equal((await registry.resolve('fixture')).executable, process.execPath);
  assert.equal(calls, 1);
  const inspected = await registry.inspect();
  assert.equal(inspected.find((entry) => entry.name === 'fixture').available, true);
  assert.equal(inspected.find((entry) => entry.name === 'missing').available, false);
  await assert.rejects(() => registry.resolve('unregistered'), /unregistered local toolchain/u);
});

test('core operation registry removes generic node.run and exposes purpose-specific build/test operations', () => {
  const toolchains = new LocalToolchainRegistry()
    .register('node', async () => ({ executable: process.execPath }))
    .register('cmake', async () => ({ executable: '/local/cmake' }))
    .register('ctest', async () => ({ executable: '/local/ctest' }))
    .register('native.c', async () => ({ executable: '/local/cc' }))
    .register('native.linker', async () => ({ executable: '/local/ld' }));
  const registry = createCoreOperationRegistry({ toolchainRegistry: toolchains });
  assert.equal(registry.has('node.run'), false);
  assert.deepEqual(registry.names(), [
    'cmake.build',
    'cmake.configure',
    'ctest.run',
    'node.syntax-check',
    'node.test',
    'toolchain.probe',
  ]);
});

test('CMake operations derive argv locally, require the sandbox guard, and put build state only in managed scratch', async () => {
  const toolchains = new LocalToolchainRegistry()
    .register('cmake', async () => ({ executable: '/local/cmake', family: 'cmake' }))
    .register('ctest', async () => ({ executable: '/local/ctest', family: 'ctest' }));
  const registry = createCoreOperationRegistry({ toolchainRegistry: toolchains });
  const observed = [];
  const sandboxChecks = [];
  const context = {
    projectDir: path.resolve('/project'),
    scratch: { directory: async (id) => path.resolve('/managed-scratch', id) },
    processRunner: {
      assertRepositorySandbox: async (operation) => { sandboxChecks.push(operation); },
      run: async (request) => {
        observed.push(request);
        return { exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '' };
      },
    },
  };

  await registry.execute('cmake.configure', {
    sourcePath: 'CMakeLists.txt',
    buildId: 'release',
    buildType: 'Release',
    generator: 'Ninja',
  }, context);
  await registry.execute('cmake.build', { buildId: 'release', config: 'Release', target: 'all' }, context);
  await registry.execute('ctest.run', { buildId: 'release', config: 'Release' }, context);

  assert.deepEqual(sandboxChecks, ['cmake.configure', 'cmake.build', 'ctest.run']);
  assert.deepEqual(observed[0].args, [
    '-S', '.', '-B', path.resolve('/managed-scratch', 'cmake-release'), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
  ]);
  assert.deepEqual(observed[1].args, ['--build', path.resolve('/managed-scratch', 'cmake-release'), '--config', 'Release', '--target', 'all']);
  assert.deepEqual(observed[2].args, ['--test-dir', path.resolve('/managed-scratch', 'cmake-release'), '--output-on-failure', '-C', 'Release']);
  assert.throws(() => registry.validate('cmake.configure', { buildId: 'x', arguments: ['--trace'] }), /parameter arguments is not allowed/u);
});
