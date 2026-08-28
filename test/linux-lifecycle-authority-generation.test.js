import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  bindLinuxLifecycleAuthorityRuntime,
  createLinuxLifecycleAuthorityPlan,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  createLinuxLifecycleAuthorityGenerationProjection,
  createLinuxLifecycleAuthorityGenerationVerificationProjection,
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_STAGING_PROTOCOL,
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL,
  normalizeLinuxLifecycleAuthorityGenerationManifest,
  stageLinuxLifecycleAuthorityGeneration,
  verifyLinuxLifecycleAuthorityGeneration,
} from '../src/setup/linux-lifecycle-authority-generation.js';
import {
  initialLinuxLifecycleAuthorityOwnershipRecord,
  normalizeLinuxLifecycleAuthorityOwnershipRecord,
} from '../src/setup/linux-lifecycle-authority-records.js';
import {
  installLinuxProtectedTree,
  verifyLinuxProtectedTree,
} from '../src/setup/linux-protected-tree.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function candidateFrom(files, nodeBytes = Buffer.from('exact node executable')) {
  const entries = Object.entries(files).map(([relative, content]) => ({
    relative,
    size: Buffer.byteLength(content),
    digest: sha256(content),
  })).sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const aggregate = createHash('sha256');
  for (const entry of entries) aggregate.update(`${entry.relative}\0${entry.size}\0${entry.digest}\n`, 'utf8');
  const packageDigest = aggregate.digest('hex');
  const nodeDigest = sha256(nodeBytes);
  return Object.freeze({
    sourceSnapshot: Object.freeze({ digest: packageDigest, files: Object.freeze(entries.map(Object.freeze)) }),
    node: Object.freeze({ size: nodeBytes.length, digest: nodeDigest }),
    evidence: Object.freeze({ packageDigest, nodeDigest }),
  });
}

function fixture({
  files = {
    'package.json': '{"name":"devbridge"}\n',
    'src/app/example.js': 'export const example = true;\n',
    'src/entry/linux-lifecycle-authority-service.mjs': 'export const service = true;\n',
  },
  current = null,
  installFailure = null,
  saveFailure = null,
} = {}) {
  const candidate = candidateFrom(files);
  const base = createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/state/devbridge',
    operatorName: 'operator',
    managementGroup: 'virt-control',
  });
  const plan = bindLinuxLifecycleAuthorityRuntime(base, candidate.evidence);
  const initial = initialLinuxLifecycleAuthorityOwnershipRecord(plan);
  let record = normalizeLinuxLifecycleAuthorityOwnershipRecord(current ?? {
    ...initial,
    localIdentity: { serviceUid: 1101, operatorUid: 1100, readGid: 1102, coordinationGid: 1103, managementGid: 1104 },
  }, plan);
  let installed = false;
  let saveFailures = 0;
  const calls = [];
  const ports = {
    state: {
      async load() {
        calls.push(['load']);
        return record;
      },
      async save(value) {
        calls.push(['save', value.stagedGeneration]);
        if (saveFailure != null && saveFailures++ === 0) throw new Error(saveFailure);
        record = normalizeLinuxLifecycleAuthorityOwnershipRecord(value, plan);
        return record;
      },
    },
    async ensureParents(parents) {
      calls.push(['parents', parents]);
      return Object.freeze({ changed: !installed });
    },
    async install(tree) {
      calls.push(['install', tree]);
      if (installFailure != null) throw new Error(installFailure);
      const changed = !installed;
      installed = true;
      return Object.freeze({ path: plan.runtime.generationDirectory, entries: tree.directories.length + tree.entries.length, changed });
    },
  };
  const value = Object.freeze({ plan, candidate, packageRoot: '/source/package', nodeExecutable: '/source/bin/node' });
  return {
    base,
    calls,
    candidate,
    get installed() { return installed; },
    get record() { return record; },
    plan,
    ports,
    setRecord(value) { record = normalizeLinuxLifecycleAuthorityOwnershipRecord(value, plan); },
    value,
  };
}

function protectedTreeFixture(values) {
  const entries = new Map();
  const put = (target, kind, { uid = 0, gid = 0, mode = kind === 'directory' ? 0o755 : 0o444, size = 0, digest = null } = {}) => {
    entries.set(target, { kind, uid, gid, mode, size, digest });
  };
  put(values.plan.runtime.stagingDirectory, 'directory');
  put(values.plan.runtime.generationsDirectory, 'directory');
  for (const entry of values.candidate.sourceSnapshot.files) {
    put(`/source/package/${entry.relative}`, 'file', { size: entry.size, digest: entry.digest });
  }
  put('/source/bin/node', 'file', { size: values.candidate.node.size, digest: values.candidate.node.digest, mode: 0o555 });
  const ready = (value, contract, kind) => Object.freeze({
    exists: value != null,
    kind: value?.kind === kind,
    owner: value?.uid === contract.ownerId,
    group: value?.gid === contract.groupId,
    mode: value?.mode === contract.mode,
  });
  const ports = {
    async observeEntry({ contract, kind }) { return ready(entries.get(contract.path), contract, kind); },
    async ensureDirectory({ contract }) {
      const current = entries.get(contract.path);
      if (current != null && (current.kind !== 'directory' || current.uid !== contract.ownerId || current.gid !== contract.groupId)) throw new Error('fake directory collision');
      put(contract.path, 'directory', { uid: contract.ownerId, gid: contract.groupId, mode: contract.mode });
      return ready(entries.get(contract.path), contract, 'directory');
    },
    async writeContent({ contract, content }) {
      put(contract.path, 'file', { uid: contract.ownerId, gid: contract.groupId, mode: contract.mode, size: content.length, digest: sha256(content) });
    },
    async transferContent({ input, output }) {
      const source = entries.get(input.path);
      if (source?.kind !== 'file' || source.size !== input.size || source.digest !== input.digest) throw new Error('fake transfer source is invalid');
      put(output.path, 'file', { uid: output.ownerId, gid: output.groupId, mode: output.mode, size: source.size, digest: source.digest });
    },
    async verifyFile({ contract, size, digest }) {
      const current = entries.get(contract.path);
      if (current?.kind !== 'file' || current.uid !== contract.ownerId || current.gid !== contract.groupId
          || current.mode !== contract.mode || current.size !== size || current.digest !== digest) throw new Error('fake installed file is invalid');
      return Object.freeze({ ready: true, size, digest });
    },
    async listDirectory(target) {
      return [...entries.keys()].filter((entry) => entry.startsWith(`${target}/`) && !entry.slice(target.length + 1).includes('/'))
        .map((entry) => entry.slice(target.length + 1));
    },
    async move(source, destination) {
      if (entries.has(destination)) throw new Error('fake destination exists');
      const selected = [...entries.entries()].filter(([target]) => target === source || target.startsWith(`${source}/`));
      for (const [target] of selected) entries.delete(target);
      for (const [target, entry] of selected) entries.set(`${destination}${target.slice(source.length)}`, entry);
    },
    async syncDirectory() {},
  };
  return { entries, ports };
}

test('generation projection emits one exact root-owned immutable tree and canonical manifest', () => {
  const values = fixture();
  const projection = createLinuxLifecycleAuthorityGenerationProjection(values.value);
  assert.equal(projection.generation, values.plan.runtime.generation);
  assert.deepEqual(projection.parents.map((entry) => entry.contract.path), [
    values.plan.runtime.stagingDirectory,
    values.plan.runtime.generationsDirectory,
  ]);
  assert.deepEqual(projection.tree.working, {
    path: `${values.plan.runtime.stagingDirectory}/${values.plan.runtime.generation}`,
    parent: projection.parents[0].contract,
  });
  assert.equal(projection.tree.installed.path, values.plan.runtime.generationDirectory);
  assert.equal(projection.tree.ownerId, 0);
  assert.equal(projection.tree.groupId, 0);
  assert.deepEqual(projection.tree.creatorIds, { ownerId: 0, groupId: 0 });
  assert.deepEqual(projection.tree.directories, ['bin', 'package', 'package/src', 'package/src/app', 'package/src/entry']);
  assert.deepEqual(projection.tree.entries.map((entry) => entry.relative), [
    'bin/node',
    'generation.json',
    'package/package.json',
    'package/src/app/example.js',
    'package/src/entry/linux-lifecycle-authority-service.mjs',
  ]);
  const manifestEntry = projection.tree.entries.find((entry) => entry.relative === 'generation.json');
  assert.equal(manifestEntry.kind, 'content');
  assert.deepEqual(JSON.parse(manifestEntry.content.toString('utf8')), projection.manifest);
  assert.deepEqual(normalizeLinuxLifecycleAuthorityGenerationManifest(projection.manifest, values.plan), {
    protocol: LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
    authorityIdentity: values.plan.authorityIdentity,
    generation: values.plan.runtime.generation,
    package: values.candidate.sourceSnapshot,
    node: values.candidate.node,
  });
  const executable = projection.tree.entries.find((entry) => entry.relative === 'bin/node');
  assert.equal(executable.mode, 0o555);
  assert.equal(executable.input.path, '/source/bin/node');
  const packageFile = projection.tree.entries.find((entry) => entry.relative === 'package/package.json');
  assert.equal(packageFile.mode, 0o444);
  assert.equal(packageFile.input.path, '/source/package/package.json');
});

test('projected generation plugs into the generic tree stud without topology knowledge in either owner', async () => {
  const values = fixture();
  const projection = createLinuxLifecycleAuthorityGenerationProjection(values.value);
  const tree = protectedTreeFixture(values);
  const first = await installLinuxProtectedTree(projection.tree, tree.ports);
  const second = await installLinuxProtectedTree(projection.tree, tree.ports);
  assert.equal(first.path, values.plan.runtime.generationDirectory);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(tree.entries.has(projection.tree.working.path), false);
  assert.equal(tree.entries.get(values.plan.runtime.nodeExecutable).mode, 0o555);
  assert.equal(tree.entries.get(values.plan.runtime.generationManifest).mode, 0o444);
});

test('projection rejects candidate ambiguity, path escape, protected-state aliasing, and foreign manifest identity', () => {
  const values = fixture();
  assert.throws(() => createLinuxLifecycleAuthorityGenerationProjection({ ...values.value, sourceName: 'foreign' }), /unknown field/u);
  assert.throws(() => createLinuxLifecycleAuthorityGenerationProjection({ ...values.value, candidate: { ...values.candidate, sourceName: 'foreign' } }), /unknown field/u);
  assert.throws(() => createLinuxLifecycleAuthorityGenerationProjection({
    ...values.value,
    candidate: {
      ...values.candidate,
      sourceSnapshot: { ...values.candidate.sourceSnapshot, files: [
        ...values.candidate.sourceSnapshot.files,
        { relative: '../escape', size: 1, digest: 'a'.repeat(64) },
      ] },
    },
  }), /path is invalid/u);
  assert.throws(() => createLinuxLifecycleAuthorityGenerationProjection({
    ...values.value,
    candidate: { ...values.candidate, sourceSnapshot: { ...values.candidate.sourceSnapshot, digest: 'a'.repeat(64) } },
  }), /snapshot digest is invalid/u);
  assert.throws(() => createLinuxLifecycleAuthorityGenerationProjection({ ...values.value, packageRoot: values.plan.protectedRoot }), /aliases protected state/u);
  assert.throws(() => createLinuxLifecycleAuthorityGenerationProjection({
    ...values.value,
    plan: {
      ...values.plan,
      access: {
        ...values.plan.access,
        protectedRuntime: { ...values.plan.access.protectedRuntime, fileMode: 0o666 },
      },
    },
  }), /widens or escapes/u);
  const projection = createLinuxLifecycleAuthorityGenerationProjection(values.value);
  assert.throws(() => normalizeLinuxLifecycleAuthorityGenerationManifest({ ...projection.manifest, generation: 'a'.repeat(64) }, values.plan), /does not match/u);
  assert.throws(() => normalizeLinuxLifecycleAuthorityGenerationManifest({
    protocol: 'devbridge/linux-lifecycle-authority-generation-v1',
    authorityIdentity: values.plan.authorityIdentity,
    generation: values.plan.runtime.generation,
    packageDigest: values.candidate.evidence.packageDigest,
    nodeDigest: values.candidate.evidence.nodeDigest,
  }, values.plan), /unknown field|does not match/u);

  const missing = fixture({ files: { 'package.json': '{}\n', 'src/app/example.js': 'export {};\n' } });
  assert.throws(() => createLinuxLifecycleAuthorityGenerationProjection(missing.value), /snapshot shape/u);
});

test('self-describing manifest reconstructs and verifies one historical generation without source paths', async () => {
  const values = fixture();
  const installation = createLinuxLifecycleAuthorityGenerationProjection(values.value);
  const tree = protectedTreeFixture(values);
  await installLinuxProtectedTree(installation.tree, tree.ports);
  const historical = createLinuxLifecycleAuthorityGenerationVerificationProjection({
    plan: values.base,
    manifest: installation.manifest,
  });
  assert.equal(historical.generation, values.plan.runtime.generation);
  assert.equal(historical.plan.runtime.generationDirectory, values.plan.runtime.generationDirectory);
  assert.equal(historical.plan.service.unit, values.plan.service.unit);
  assert.deepEqual(historical.tree.directories, installation.tree.directories);
  assert.deepEqual(historical.tree.entries.map(({ relative, mode, maximumBytes, size, digest }) => ({ relative, mode, maximumBytes, size, digest })), installation.tree.entries.map((entry) => ({
    relative: entry.relative,
    mode: entry.mode,
    maximumBytes: entry.maximumBytes,
    size: entry.kind === 'content' ? entry.content.length : entry.input.size,
    digest: entry.kind === 'content' ? sha256(entry.content) : entry.input.digest,
  })));
  const observed = await verifyLinuxLifecycleAuthorityGeneration({ plan: values.base, manifest: installation.manifest }, {
    verify: async (request) => {
      const evidence = await verifyLinuxProtectedTree(request, {
        observeEntry: tree.ports.observeEntry,
        verifyFile: tree.ports.verifyFile,
        listDirectory: tree.ports.listDirectory,
      });
      return { path: evidence.path, entries: evidence.entries, ready: evidence.ready };
    },
  });
  assert.deepEqual(observed, {
    protocol: LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL,
    generation: values.plan.runtime.generation,
    verified: true,
  });
});

test('forged manifest inventory and widened verification evidence fail closed', async () => {
  const values = fixture();
  const projection = createLinuxLifecycleAuthorityGenerationProjection(values.value);
  const forgedFile = {
    ...projection.manifest,
    package: {
      ...projection.manifest.package,
      files: projection.manifest.package.files.map((entry, index) => index === 0 ? { ...entry, size: entry.size + 1 } : entry),
    },
  };
  assert.throws(() => normalizeLinuxLifecycleAuthorityGenerationManifest(forgedFile, values.base), /snapshot digest is invalid/u);
  await assert.rejects(() => verifyLinuxLifecycleAuthorityGeneration({ plan: values.base, manifest: projection.manifest }, {
    verify: async (request) => ({ path: request.root.path, entries: request.entries.length + request.directories.length, ready: true, source: 'foreign' }),
  }), /unknown field/u);
  await assert.rejects(() => verifyLinuxLifecycleAuthorityGeneration({ plan: values.base, manifest: projection.manifest }, {
    verify: async (request) => ({ path: request.root.path, entries: 1, ready: true }),
  }), /evidence is invalid/u);
});

test('generation record rejects an inventory that cannot fit its bounded durable evidence', () => {
  const seed = fixture();
  const files = [
    { relative: 'package.json', size: 1, digest: 'a'.repeat(64) },
    { relative: 'src/entry/linux-lifecycle-authority-service.mjs', size: 1, digest: 'b'.repeat(64) },
  ];
  for (let index = 0; index < 2_046; index += 1) {
    files.push({
      relative: `src/${'x'.repeat(240)}/${'y'.repeat(240)}/${String(index).padStart(4, '0')}.js`,
      size: 1,
      digest: sha256(String(index)),
    });
  }
  files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const aggregate = createHash('sha256');
  for (const entry of files) aggregate.update(`${entry.relative}\0${entry.size}\0${entry.digest}\n`, 'utf8');
  const packageDigest = aggregate.digest('hex');
  const node = { size: 1, digest: 'c'.repeat(64) };
  const plan = bindLinuxLifecycleAuthorityRuntime(seed.base, { packageDigest, nodeDigest: node.digest });
  assert.throws(() => normalizeLinuxLifecycleAuthorityGenerationManifest({
    protocol: LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
    authorityIdentity: plan.authorityIdentity,
    generation: plan.runtime.generation,
    package: { digest: packageDigest, files },
    node,
  }, plan), /manifest is outside its bound/u);
});

test('fresh staging installs and verifies bytes before recording the staged generation', async () => {
  const values = fixture();
  const result = await stageLinuxLifecycleAuthorityGeneration(values.value, values.ports);
  assert.deepEqual(result, {
    protocol: LINUX_LIFECYCLE_AUTHORITY_GENERATION_STAGING_PROTOCOL,
    generation: values.plan.runtime.generation,
    path: values.plan.runtime.generationDirectory,
    state: 'staged',
    changed: true,
  });
  assert.deepEqual(values.calls.map(([name]) => name), ['load', 'parents', 'install', 'save']);
  assert.equal(values.record.stagedGeneration, values.plan.runtime.generation);
  assert.equal(values.installed, true);
});

test('an exact staged generation is verified as a no-op while active generations are not restaged', async () => {
  const staged = fixture();
  staged.setRecord({ ...staged.record, stagedGeneration: staged.plan.runtime.generation });
  const stagedResult = await stageLinuxLifecycleAuthorityGeneration(staged.value, staged.ports);
  const second = await stageLinuxLifecycleAuthorityGeneration(staged.value, staged.ports);
  assert.equal(stagedResult.state, 'staged');
  assert.equal(stagedResult.changed, true);
  assert.equal(second.changed, false);
  assert.equal(staged.calls.some(([name]) => name === 'save'), false);

  const active = fixture();
  active.setRecord({ ...active.record, activeGeneration: active.plan.runtime.generation });
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(active.value, active.ports), /already active/u);
  assert.deepEqual(active.calls.map(([name]) => name), ['load']);
  assert.equal(active.calls.some(([name]) => name === 'save'), false);
});

test('a published tree with a lost ownership update resumes by recording only exact state', async () => {
  const values = fixture({ saveFailure: 'ownership checkpoint interrupted' });
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(values.value, values.ports), /checkpoint interrupted/u);
  assert.equal(values.installed, true);
  assert.equal(values.record.stagedGeneration, null);
  const resumed = await stageLinuxLifecycleAuthorityGeneration(values.value, values.ports);
  assert.equal(resumed.state, 'staged');
  assert.equal(values.record.stagedGeneration, values.plan.runtime.generation);
  assert.equal(values.calls.filter(([name]) => name === 'install').length, 2);
  assert.equal(values.calls.filter(([name]) => name === 'save').length, 2);
});

test('ambiguous ownership and failed installation block before a stage record is written', async () => {
  const missingClaim = fixture();
  const missingPorts = { ...missingClaim.ports, state: { ...missingClaim.ports.state, async load() { missingClaim.calls.push(['load']); return null; } } };
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(missingClaim.value, missingPorts), /established ownership claim/u);
  assert.deepEqual(missingClaim.calls.map(([name]) => name), ['load']);

  const absentIdentity = fixture();
  absentIdentity.setRecord({ ...absentIdentity.record, localIdentity: null });
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(absentIdentity.value, absentIdentity.ports), /exact numeric identity/u);
  assert.deepEqual(absentIdentity.calls.map(([name]) => name), ['load']);

  const conflicting = fixture();
  conflicting.setRecord({ ...conflicting.record, stagedGeneration: 'a'.repeat(64) });
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(conflicting.value, conflicting.ports), /another staged generation/u);
  assert.deepEqual(conflicting.calls.map(([name]) => name), ['load']);

  const retained = fixture();
  retained.setRecord({ ...retained.record, retainedGenerations: [retained.plan.runtime.generation] });
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(retained.value, retained.ports), /retained state/u);
  assert.deepEqual(retained.calls.map(([name]) => name), ['load']);

  const failed = fixture({ installFailure: 'source bytes changed' });
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(failed.value, failed.ports), /source bytes changed/u);
  assert.equal(failed.calls.some(([name]) => name === 'save'), false);
  assert.equal(failed.record.stagedGeneration, null);

  const inexactSave = fixture();
  const inexactPorts = {
    ...inexactSave.ports,
    state: {
      ...inexactSave.ports.state,
      async save(value) {
        inexactSave.calls.push(['save', value.stagedGeneration]);
        return normalizeLinuxLifecycleAuthorityOwnershipRecord({ ...value, stagedGeneration: null }, inexactSave.plan);
      },
    },
  };
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(inexactSave.value, inexactPorts), /stage record is not exact/u);
  assert.equal(inexactSave.installed, true);
  assert.equal(inexactSave.record.stagedGeneration, null);
});

test('generation staging contract rejects topology-shaped ports and remains provider-isolated', async () => {
  const values = fixture();
  await assert.rejects(() => stageLinuxLifecycleAuthorityGeneration(values.value, { ...values.ports, serviceName: 'foreign' }), /unknown field/u);
  assert.equal(values.calls.length, 0);
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-generation.js', import.meta.url)), 'utf8');
  for (const forbidden of ['systemctl', 'useradd', 'groupadd', 'libvirt', 'qemu', 'polkit', 'repository', 'virtual machine', 'powershell', 'hyper-v', 'sudo']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, `generation staging gained neighboring authority through ${forbidden}`);
  }
});
