import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL,
  UBUNTU_APT_ISOLATED_CONFIGURATION,
  UbuntuAptTransactionSolver,
  normalizeUbuntuAptTransactionSolution,
  parseUbuntuAptSimulation,
  parseUbuntuInstalledPackageState,
  ubuntuPackageStateSha256,
} from '../src/release/ubuntu-apt-transaction-solver.mjs';

const SNAPSHOT = '20260821T230000Z';

function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function status(packages) {
  return Buffer.from(`${packages.map((item) => [
    `Package: ${item.package}`,
    'Status: install ok installed',
    `Architecture: ${item.architecture}`,
    `Version: ${item.version}`,
  ].join('\n')).join('\n\n')}\n`, 'utf8');
}

function inst(item, previous = null) {
  return `Inst ${item.package}${item.qualifier ?? ''}${previous ? ` [${previous}]` : ''} (${item.version} resolute [${item.architecture}])`;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-apt-solver-'));
  const workspace = path.join(root, 'workspace');
  const sourcePartsDirectory = path.join(workspace, 'source-parts');
  const listsDirectory = path.join(workspace, 'lists');
  await mkdir(sourcePartsDirectory, { recursive: true });
  await mkdir(listsDirectory);
  const configurationFile = path.join(workspace, 'apt.conf');
  const statusFile = path.join(workspace, 'status');
  const sourcesListFile = path.join(workspace, 'sources.list');
  await writeFile(configurationFile, UBUNTU_APT_ISOLATED_CONFIGURATION);
  await writeFile(statusFile, status([
    { package: 'base-files', version: '1.0', architecture: 'amd64' },
    { package: 'libc6', version: '1.0', architecture: 'amd64' },
  ]));
  await writeFile(sourcesListFile, `deb [snapshot=${SNAPSHOT}] https://snapshot.invalid/ubuntu resolute main universe\n`);
  await writeFile(path.join(listsDirectory, 'resolute_main_binary-amd64_Packages'), 'fixture-index\n');
  return {
    root,
    request: {
      workspace,
      configurationFile,
      statusFile,
      sourcesListFile,
      sourcePartsDirectory,
      listsDirectory,
      snapshot: SNAPSHOT,
      architecture: 'amd64',
      requestedPackages: ['cmake', 'build-essential'],
    },
  };
}

function successfulOutputs() {
  const upgrade = `${inst({ package: 'libc6', version: '2.0', architecture: 'amd64' }, '1.0')}\nConf libc6 (2.0 resolute [amd64])\n`;
  const combined = [
    inst({ package: 'libc6', version: '2.0', architecture: 'amd64' }, '1.0'),
    inst({ package: 'make', version: '4.4-1', architecture: 'amd64' }),
    inst({ package: 'build-essential', version: '12.12', architecture: 'amd64' }),
    inst({ package: 'cmake', version: '3.31.6', architecture: 'amd64' }),
    'Conf make (4.4-1 resolute [amd64])',
  ].join('\n');
  return { upgrade, combined: `${combined}\n` };
}

test('installed-state parser and digest are canonical and ignore non-installed stanzas', () => {
  const bytes = Buffer.from([
    'Package: zlib1g',
    'Status: install ok installed',
    'Architecture: amd64',
    'Version: 1:1.3',
    'Description: first\n continuation',
    '',
    'Package: removed',
    'Status: deinstall ok config-files',
    'Architecture: amd64',
    'Version: 1.0',
    '',
    'Package: base-files',
    'Status: install ok installed',
    'Architecture: all',
    'Version: 2.0',
    '',
  ].join('\n'));
  const parsed = parseUbuntuInstalledPackageState(bytes);
  assert.deepEqual(parsed, [
    { package: 'base-files', version: '2.0', architecture: 'all' },
    { package: 'zlib1g', version: '1:1.3', architecture: 'amd64' },
  ]);
  assert.equal(ubuntuPackageStateSha256(parsed), ubuntuPackageStateSha256([...parsed].reverse()));
  assert.throws(() => parseUbuntuInstalledPackageState(Buffer.from('Package: duplicate\nPackage: duplicate\n')), /paragraph 0 is invalid/u);
});

test('simulation parser accepts exact Inst/Conf evidence and rejects removals or prose', () => {
  assert.deepEqual(parseUbuntuAptSimulation([
    'Inst libc6:amd64 [1.0] (2.0 resolute-updates [amd64])',
    'Inst linux-libc-dev (6.14 resolute [all])',
    'Conf libc6 (2.0 resolute-updates [amd64])',
    '',
  ].join('\n')), [
    { package: 'libc6', version: '2.0', architecture: 'amd64' },
    { package: 'linux-libc-dev', version: '6.14', architecture: 'all' },
  ]);
  assert.throws(() => parseUbuntuAptSimulation('Remv openssh-server [1.0]\n'), /requested package removal/u);
  assert.throws(() => parseUbuntuAptSimulation('The following packages will be installed:\n'), /unsupported output/u);
  assert.throws(() => parseUbuntuAptSimulation('Conf malformed\n'), /unsupported output/u);
  assert.throws(() => parseUbuntuAptSimulation('Inst libc6:arm64 [1.0] (2.0 resolute [amd64])\n'), /architecture disagrees/u);
});

test('solver binds one explicit private state to a complete combined no-removal result', async () => {
  const built = await fixture();
  const calls = [];
  const outputs = successfulOutputs();
  try {
    const solver = new UbuntuAptTransactionSolver({
      executable: process.execPath,
      run: async (executable, args, environment, signal) => {
        calls.push({ executable, args, environment, signal });
        return { code: 0, signal: null, stdout: calls.length === 1 ? outputs.upgrade : outputs.combined, stderr: '' };
      },
    });
    const result = await solver.solve(built.request);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].executable, process.execPath);
    assert.deepEqual(calls[0].args.slice(-3), ['--with-new-pkgs', '--no-remove', 'upgrade']);
    assert.ok(calls[0].args.includes('--simulate'));
    assert.ok(calls[0].args.includes(SNAPSHOT));
    assert.ok(!calls[0].args.includes('--no-list-columns'));
    assert.deepEqual(calls[1].args.slice(-6), [
      '--no-remove', '--no-install-recommends', 'install', 'libc6:amd64=2.0', 'build-essential', 'cmake',
    ]);
    assert.equal(calls[0].environment.APT_CONFIG, built.request.configurationFile);
    assert.deepEqual(Object.keys(calls[0].environment).filter((name) => !['SystemRoot', 'SYSTEMROOT', 'WINDIR'].includes(name)).sort(), ['APT_CONFIG', 'LANG', 'LC_ALL']);
    assert.equal(result.protocol, UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL);
    assert.deepEqual(result.requestedPackages.map((item) => [item.package, item.version]), [
      ['build-essential', '12.12'], ['cmake', '3.31.6'],
    ]);
    assert.deepEqual(result.selectedPackages.map((item) => item.package), ['build-essential', 'cmake', 'libc6', 'make']);
    assert.deepEqual(result.resultPackages.map((item) => [item.package, item.version]), [
      ['base-files', '1.0'], ['build-essential', '12.12'], ['cmake', '3.31.6'], ['libc6', '2.0'], ['make', '4.4-1'],
    ]);
    assert.equal(result.transaction.basePackageStateSha256, ubuntuPackageStateSha256(result.basePackages));
    assert.equal(result.transaction.resultPackageStateSha256, ubuntuPackageStateSha256(result.resultPackages));
    assert.deepEqual(result.transaction.requestedPackages, [
      { name: 'build-essential', version: '12.12' }, { name: 'cmake', version: '3.31.6' },
    ]);
  } finally {
    await rm(built.root, { recursive: true, force: true });
  }
});

test('solution normalization is order-independent and rejects invented changes or removals', () => {
  const raw = {
    protocol: UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL,
    snapshot: SNAPSHOT,
    architecture: 'amd64',
    basePackages: [{ package: 'base-files', version: '1', architecture: 'amd64' }],
    resultPackages: [
      { package: 'tool', version: '2', architecture: 'amd64' },
      { package: 'base-files', version: '1', architecture: 'amd64' },
    ],
    selectedPackages: [{ package: 'tool', version: '2', architecture: 'amd64' }],
    requestedPackages: [{ package: 'tool', version: '2', architecture: 'amd64' }],
  };
  const first = normalizeUbuntuAptTransactionSolution(raw);
  const second = normalizeUbuntuAptTransactionSolution({ ...raw, resultPackages: [...raw.resultPackages].reverse() });
  assert.deepEqual(first, second);
  assert.throws(() => normalizeUbuntuAptTransactionSolution({ ...raw, basePackages: [...raw.basePackages, { package: 'removed', version: '1', architecture: 'amd64' }] }), /removes removed/u);
  assert.throws(() => normalizeUbuntuAptTransactionSolution({ ...raw, resultPackages: [...raw.resultPackages, { package: 'invented', version: '1', architecture: 'amd64' }] }), /not selected/u);
  assert.throws(() => normalizeUbuntuAptTransactionSolution({
    ...raw,
    basePackages: [{ package: 'base-files', version: '2', architecture: 'amd64' }],
    resultPackages: [{ package: 'base-files', version: '1', architecture: 'amd64' }, ...raw.resultPackages.slice(0, 1)],
    selectedPackages: [{ package: 'base-files', version: '1', architecture: 'amd64' }, ...raw.selectedPackages],
  }), /downgrades base-files/u);
});

test('solver rejects phase drift, failed APT, and changed input evidence', async () => {
  const outputs = successfulOutputs();
  for (const mode of ['drift', 'failed', 'changed']) {
    const built = await fixture();
    let call = 0;
    try {
      const solver = new UbuntuAptTransactionSolver({
        executable: process.execPath,
        run: async () => {
          call += 1;
          if (mode === 'failed') return { code: 100, signal: null, stdout: '', stderr: 'solver failed' };
          if (mode === 'changed' && call === 2) await writeFile(path.join(built.request.listsDirectory, 'resolute_main_binary-amd64_Packages'), 'changed\n');
          const combined = mode === 'drift'
            ? outputs.combined.replace('libc6 [1.0] (2.0', 'libc6 [1.0] (3.0')
            : outputs.combined;
          return { code: 0, signal: null, stdout: call === 1 ? outputs.upgrade : combined, stderr: '' };
        },
      });
      await assert.rejects(solver.solve(built.request), mode === 'drift'
        ? /changed the no-removal upgrade selection/u
        : mode === 'failed' ? /upgrade simulation failed/u : /input state changed/u);
    } finally {
      await rm(built.root, { recursive: true, force: true });
    }
  }
});

test('solver rejects prior and late cancellation plus diagnostic stderr', async () => {
  const outputs = successfulOutputs();
  for (const mode of ['prior', 'late', 'stderr']) {
    const built = await fixture();
    const controller = new AbortController();
    let call = 0;
    if (mode === 'prior') controller.abort(new Error('operator interrupted solving'));
    try {
      const solver = new UbuntuAptTransactionSolver({
        executable: process.execPath,
        run: async () => {
          call += 1;
          if (mode === 'late' && call === 2) controller.abort(new Error('operator interrupted solving'));
          return {
            code: 0,
            signal: null,
            stdout: call === 1 ? outputs.upgrade : outputs.combined,
            stderr: mode === 'stderr' ? 'W: unexpected policy diagnostic\n' : '',
          };
        },
      });
      await assert.rejects(solver.solve({ ...built.request, signal: controller.signal }), mode === 'stderr'
        ? /simulation failed \(exit 0\): W: unexpected policy diagnostic/u : /operator interrupted solving/u);
      if (mode === 'prior') assert.equal(call, 0);
    } finally {
      await rm(built.root, { recursive: true, force: true });
    }
  }
});

test('solver rejects linked inputs, ambiguous requests, unknown fields, and oversized combined argv', async () => {
  const linked = await fixture();
  try {
    const hardlink = path.join(linked.request.workspace, 'status-link');
    await link(linked.request.statusFile, hardlink);
    const solver = new UbuntuAptTransactionSolver({ executable: process.execPath, run: async () => assert.fail('runner must not start') });
    await assert.rejects(solver.solve(linked.request), /bounded unlinked regular file/u);
  } finally {
    await rm(linked.root, { recursive: true, force: true });
  }

  const invalid = await fixture();
  try {
    const solver = new UbuntuAptTransactionSolver({ executable: process.execPath, run: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }) });
    await assert.rejects(solver.solve({ ...invalid.request, requestedPackages: ['cmake', 'cmake'] }), /must be unique/u);
    await assert.rejects(solver.solve({ ...invalid.request, extra: true }), /extra is unsupported/u);
    await writeFile(invalid.request.configurationFile, 'APT::Solver "anything";\n');
    await assert.rejects(solver.solve(invalid.request), /does not disable host configuration/u);
    await writeFile(invalid.request.configurationFile, UBUNTU_APT_ISOLATED_CONFIGURATION);

    let calls = 0;
    const longSolver = new UbuntuAptTransactionSolver({
      executable: process.execPath,
      run: async () => {
        calls += 1;
        const stdout = Array.from({ length: 3000 }, (_, index) => inst({
          package: `package-${String(index).padStart(4, '0')}-${'x'.repeat(75)}`,
          version: `${index + 1}.${'9'.repeat(180)}`,
          architecture: 'amd64',
        })).join('\n');
        return { code: 0, signal: null, stdout, stderr: '' };
      },
    });
    await assert.rejects(longSolver.solve(invalid.request), /arguments exceed their bound/u);
    assert.equal(calls, 1);
  } finally {
    await rm(invalid.root, { recursive: true, force: true });
  }
});

test('real apt-get solves a disposable private no-removal universe on Linux', {
  skip: process.platform !== 'linux' ? 'requires the hosted Ubuntu apt-get adapter' : false,
}, async () => {
  await Promise.all([access('/usr/bin/apt-get'), access('/usr/bin/dpkg-deb')]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-apt-real-'));
  const workspace = path.join(root, 'workspace');
  const repository = path.join(root, 'repository');
  const pool = path.join(repository, 'pool');
  const indexDirectory = path.join(repository, 'dists', 'stable', 'main', 'binary-amd64');
  const listsDirectory = path.join(workspace, 'lists');
  const sourcePartsDirectory = path.join(workspace, 'source-parts');
  const configurationFile = path.join(workspace, 'apt.conf');
  const statusFile = path.join(workspace, 'status');
  const sourcesListFile = path.join(workspace, 'sources.list');
  try {
    await Promise.all([
      mkdir(pool, { recursive: true }), mkdir(indexDirectory, { recursive: true }),
      mkdir(listsDirectory, { recursive: true }), mkdir(sourcePartsDirectory, { recursive: true }),
    ]);
    const packages = [
      { package: 'fixture-dependency', version: '1.0', depends: null },
      { package: 'fixture-base', version: '2.0', depends: 'fixture-dependency (= 1.0)' },
      { package: 'fixture-tool', version: '1.0', depends: 'fixture-base (= 2.0)' },
    ];
    const records = [];
    for (const item of packages) {
      const buildRoot = path.join(root, `build-${item.package}`);
      const control = path.join(buildRoot, 'DEBIAN');
      await mkdir(control, { recursive: true });
      await writeFile(path.join(control, 'control'), [
        `Package: ${item.package}`,
        `Version: ${item.version}`,
        'Architecture: amd64',
        'Maintainer: DevBridge fixture <fixture@example.invalid>',
        ...(item.depends ? [`Depends: ${item.depends}`] : []),
        'Description: DevBridge private APT solver fixture',
        '',
      ].join('\n'));
      const filename = `${item.package}_${item.version}_amd64.deb`;
      const location = path.join(pool, filename);
      const built = await command('/usr/bin/dpkg-deb', ['--build', '--root-owner-group', buildRoot, location], { env: { LANG: 'C', LC_ALL: 'C' } });
      assert.equal(built.code, 0, built.stderr);
      const bytes = await readFile(location);
      records.push([
        `Package: ${item.package}`,
        `Version: ${item.version}`,
        'Architecture: amd64',
        ...(item.depends ? [`Depends: ${item.depends}`] : []),
        `Filename: pool/${filename}`,
        `Size: ${bytes.length}`,
        `SHA256: ${createHash('sha256').update(bytes).digest('hex')}`,
        'Description: DevBridge private APT solver fixture',
      ].join('\n'));
    }
    const packageBytes = Buffer.from(`${records.join('\n\n')}\n`, 'utf8');
    await writeFile(path.join(indexDirectory, 'Packages'), packageBytes);
    await writeFile(path.join(repository, 'dists', 'stable', 'Release'), [
      'Origin: DevBridgeFixture',
      'Label: DevBridgeFixture',
      'Suite: stable',
      'Codename: stable',
      'Architectures: amd64',
      'Components: main',
      'SHA256:',
      ` ${createHash('sha256').update(packageBytes).digest('hex')} ${packageBytes.length} main/binary-amd64/Packages`,
      '',
    ].join('\n'));
    await writeFile(configurationFile, UBUNTU_APT_ISOLATED_CONFIGURATION);
    await writeFile(statusFile, status([{ package: 'fixture-base', version: '1.0', architecture: 'amd64' }]));
    await writeFile(sourcesListFile, `deb [trusted=yes] file:${repository} stable main\n`);
    const updateArgs = [
      '-o', `Dir::State::status=${statusFile}`,
      '-o', `Dir::State::lists=${listsDirectory}`,
      '-o', `Dir::Etc::sourcelist=${sourcesListFile}`,
      '-o', `Dir::Etc::sourceparts=${sourcePartsDirectory}`,
      '-o', 'Dir::Cache::pkgcache=', '-o', 'Dir::Cache::srcpkgcache=',
      '-o', 'Debug::NoLocking=true', '-o', 'Acquire::Languages=none',
      'update', '--quiet=2',
    ];
    const updated = await command('/usr/bin/apt-get', updateArgs, {
      env: { LANG: 'C', LC_ALL: 'C', APT_CONFIG: configurationFile },
    });
    assert.equal(updated.code, 0, updated.stderr);
    await Promise.all([
      rm(path.join(listsDirectory, 'partial'), { recursive: true, force: true }),
      rm(path.join(listsDirectory, 'auxfiles'), { recursive: true, force: true }),
      rm(path.join(listsDirectory, 'lock'), { force: true }),
    ]);
    for (const entry of await readdir(listsDirectory, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const location = path.join(listsDirectory, entry.name);
      const bytes = await readFile(location);
      await rm(location);
      await writeFile(location, bytes);
    }
    const capturedLists = await readdir(listsDirectory, { withFileTypes: true });
    assert.ok(capturedLists.length > 0);
    assert.ok(capturedLists.every((entry) => entry.isFile() && !entry.isSymbolicLink()));
    const solver = new UbuntuAptTransactionSolver({ executable: '/usr/bin/apt-get' });
    const solution = await solver.solve({
      workspace,
      configurationFile,
      statusFile,
      sourcesListFile,
      sourcePartsDirectory,
      listsDirectory,
      snapshot: SNAPSHOT,
      architecture: 'amd64',
      requestedPackages: ['fixture-tool'],
    });
    assert.deepEqual(solution.resultPackages.map((item) => [item.package, item.version]), [
      ['fixture-base', '2.0'], ['fixture-dependency', '1.0'], ['fixture-tool', '1.0'],
    ]);
    assert.deepEqual(solution.selectedPackages.map((item) => item.package), [
      'fixture-base', 'fixture-dependency', 'fixture-tool',
    ]);
    assert.deepEqual(solution.transaction.requestedPackages, [{ name: 'fixture-tool', version: '1.0' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release solver source keeps setup, provider, construction, and live-origin behavior outside', async () => {
  const source = await readFile(new URL('../src/release/ubuntu-apt-transaction-solver.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['snapshot.ubuntu.com', 'archive.ubuntu.com', 'setup --construct', 'Hyper-V', 'libvirt', 'prepareRuntimeCandidate']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'u'));
  }
  assert.match(source, /shell: false/u);
  assert.match(source, /--with-new-pkgs/u);
  assert.match(source, /--no-remove/u);
});
