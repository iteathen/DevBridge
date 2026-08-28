import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
  projectLinuxLifecycleAuthorityRuntime,
} from './linux-lifecycle-authority.js';
import {
  normalizeLinuxLifecycleAuthorityOwnershipRecord,
} from './linux-lifecycle-authority-records.js';
import {
  PROTECTED_AUTHORITY_RUNTIME_BOUNDS,
} from './protected-authority-runtime-candidate.js';
const PROTOCOL = 'devbridge/linux-lifecycle-authority-generation-staging-v1';
const PROJECTION_PROTOCOL = 'devbridge/linux-lifecycle-authority-generation-projection-v1';
const VERIFICATION_PROJECTION_PROTOCOL = 'devbridge/linux-lifecycle-authority-generation-verification-projection-v1';
const VERIFICATION_PROTOCOL = 'devbridge/linux-lifecycle-authority-generation-verification-v1';
const GENERATION_PROTOCOL = 'devbridge/linux-lifecycle-authority-generation-v2';
const DIGEST = /^[0-9a-f]{64}$/u;
const MANIFEST_BYTES = 1024 * 1024;
const PENDING_SUFFIX = '.devbridge-pending';
const SERVICE_ENTRY = 'src/entry/linux-lifecycle-authority-service.mjs';

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function positive(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function absoluteLinuxPath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function relativePackagePath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || /[\\\0\r\n]/u.test(value)
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || ['.', '..'].includes(value)
      || value.split('/').some((segment) => segment.length < 1 || segment.length > 255 || segment === '..' || segment.endsWith(PENDING_SUFFIX))
      || (value !== 'package.json' && !value.startsWith('src/'))) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function depth(value) {
  return value.split('/').length;
}

function atOrBelow(root, target) {
  const relative = path.posix.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

function validateProjectedPlan(projected) {
  if (absoluteLinuxPath(projected.protectedRoot, 'Linux lifecycle authority protected root') !== projected.protectedRoot
      || path.posix.dirname(projected.runtime.stagingDirectory) !== projected.protectedRoot
      || path.posix.dirname(projected.runtime.generationsDirectory) !== projected.protectedRoot
      || projected.runtime.stagingDirectory === projected.runtime.generationsDirectory
      || path.posix.dirname(projected.runtime.generationDirectory) !== projected.runtime.generationsDirectory
      || projected.access?.protectedRoot?.mode !== 0o755
      || projected.access?.protectedRuntime?.directoryMode !== 0o755
      || projected.access?.protectedRuntime?.fileMode !== 0o444
      || projected.access?.protectedRuntime?.executableMode !== 0o555) {
    throw new Error('Linux lifecycle authority generation plan widens or escapes protected runtime policy');
  }
  return projected;
}

function exactPlan(value) {
  if (!value || value.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || value.runtimeEvidence == null
      || value.runtime?.generation == null || typeof value.service?.unit !== 'string') {
    throw new TypeError('Linux lifecycle authority generation plan is invalid');
  }
  const projected = projectLinuxLifecycleAuthorityRuntime(value, value.runtimeEvidence);
  const keys = [
    'generation',
    'generationDirectory',
    'generationsDirectory',
    'stagingDirectory',
    'generationManifest',
    'nodeExecutable',
    'packageDirectory',
    'packageManifest',
    'serviceEntry',
  ];
  if (keys.some((key) => value.runtime[key] !== projected.runtime[key]) || value.service.unit !== projected.service.unit) {
    throw new Error('Linux lifecycle authority generation plan does not match its exact runtime evidence');
  }
  return validateProjectedPlan(projected);
}

function normalizedPackage(value) {
  exactKeys(value, new Set(['digest', 'files']), 'Linux lifecycle authority package snapshot');
  const packageDigest = digest(value.digest, 'Linux lifecycle authority package snapshot digest');
  if (!Array.isArray(value.files) || value.files.length < 2
      || value.files.length > PROTECTED_AUTHORITY_RUNTIME_BOUNDS.packageFiles) {
    throw new TypeError('Linux lifecycle authority package snapshot files are invalid');
  }
  const files = value.files.map((entry, index) => {
    exactKeys(entry, new Set(['relative', 'size', 'digest']), `Linux lifecycle authority package file ${index}`);
    return Object.freeze({
      relative: relativePackagePath(entry.relative, `Linux lifecycle authority package file ${index} path`),
      size: positive(entry.size, `Linux lifecycle authority package file ${index} size`, PROTECTED_AUTHORITY_RUNTIME_BOUNDS.packageFileBytes),
      digest: digest(entry.digest, `Linux lifecycle authority package file ${index} digest`),
    });
  }).sort((left, right) => codePointCompare(left.relative, right.relative));
  if (new Set(files.map((entry) => entry.relative)).size !== files.length
      || !files.some((entry) => entry.relative === 'package.json')
      || !files.some((entry) => entry.relative === SERVICE_ENTRY)) {
    throw new TypeError('Linux lifecycle authority package snapshot shape is invalid');
  }
  let total = 0;
  const aggregate = createHash('sha256');
  for (const entry of files) {
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > PROTECTED_AUTHORITY_RUNTIME_BOUNDS.packageBytes) {
      throw new TypeError('Linux lifecycle authority package snapshot bytes are invalid');
    }
    aggregate.update(`${entry.relative}\0${entry.size}\0${entry.digest}\n`, 'utf8');
  }
  if (aggregate.digest('hex') !== packageDigest) throw new Error('Linux lifecycle authority package snapshot digest is invalid');
  return Object.freeze({ digest: packageDigest, files: Object.freeze(files) });
}

function normalizedNode(value) {
  exactKeys(value, new Set(['size', 'digest']), 'Linux lifecycle authority executable evidence');
  return Object.freeze({
    size: positive(value.size, 'Linux lifecycle authority executable size', PROTECTED_AUTHORITY_RUNTIME_BOUNDS.executableBytes),
    digest: digest(value.digest, 'Linux lifecycle authority executable digest'),
  });
}

function normalizedCandidate(value, plan) {
  exactKeys(value, new Set(['sourceSnapshot', 'node', 'evidence']), 'Linux lifecycle authority generation candidate');
  exactKeys(value.evidence, new Set(['packageDigest', 'nodeDigest']), 'Linux lifecycle authority candidate evidence');
  const sourceSnapshot = normalizedPackage(value.sourceSnapshot);
  const node = normalizedNode(value.node);
  if (digest(value.evidence.packageDigest, 'Linux lifecycle authority candidate package digest') !== sourceSnapshot.digest
      || digest(value.evidence.nodeDigest, 'Linux lifecycle authority candidate executable digest') !== node.digest
      || sourceSnapshot.digest !== plan.runtimeEvidence.packageDigest || node.digest !== plan.runtimeEvidence.nodeDigest) {
    throw new Error('Linux lifecycle authority candidate does not match the exact runtime plan');
  }
  return Object.freeze({
    sourceSnapshot,
    node,
    evidence: Object.freeze({ packageDigest: sourceSnapshot.digest, nodeDigest: node.digest }),
  });
}

function parentContract(target, plan) {
  return Object.freeze({
    contract: Object.freeze({ path: target, ownerId: 0, groupId: 0, mode: plan.access.protectedRuntime.directoryMode }),
    parent: Object.freeze({ path: plan.protectedRoot, ownerId: 0, groupId: 0, mode: plan.access.protectedRoot.mode }),
  });
}

function manifestBytes(value) {
  const content = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (content.length < 2 || content.length > MANIFEST_BYTES) throw new Error('Linux lifecycle authority generation manifest is outside its bound');
  return content;
}

export function normalizeLinuxLifecycleAuthorityGenerationManifest(value, providedPlan) {
  if (!providedPlan || providedPlan.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL) {
    throw new TypeError('Linux lifecycle authority generation record plan is invalid');
  }
  if (providedPlan.runtimeEvidence == null && (providedPlan.runtime?.generation != null || providedPlan.service?.unit != null)) {
    throw new TypeError('Linux lifecycle authority generation record base plan is invalid');
  }
  exactKeys(value, new Set(['protocol', 'authorityIdentity', 'generation', 'package', 'node']), 'Linux lifecycle authority generation record');
  if (value.protocol !== GENERATION_PROTOCOL || value.authorityIdentity !== providedPlan.authorityIdentity) {
    throw new Error('Linux lifecycle authority generation record does not match the exact installation candidate');
  }
  const packageSnapshot = normalizedPackage(value.package);
  const node = normalizedNode(value.node);
  const plan = validateProjectedPlan(projectLinuxLifecycleAuthorityRuntime(providedPlan, {
    packageDigest: packageSnapshot.digest,
    nodeDigest: node.digest,
  }));
  if (digest(value.generation, 'Linux lifecycle authority generation record identity') !== plan.runtime.generation
      || (providedPlan.runtimeEvidence != null && (providedPlan.runtimeEvidence.packageDigest !== packageSnapshot.digest
        || providedPlan.runtimeEvidence.nodeDigest !== node.digest
        || providedPlan.runtime?.generation !== plan.runtime.generation
        || providedPlan.service?.unit !== plan.service.unit))) {
    throw new Error('Linux lifecycle authority generation record does not match the exact installation candidate');
  }
  const normalized = Object.freeze({
    protocol: GENERATION_PROTOCOL,
    authorityIdentity: plan.authorityIdentity,
    generation: plan.runtime.generation,
    package: packageSnapshot,
    node,
  });
  manifestBytes(normalized);
  return normalized;
}

export function createLinuxLifecycleAuthorityGenerationProjection(value = {}) {
  exactKeys(value, new Set(['plan', 'candidate', 'packageRoot', 'nodeExecutable']), 'Linux lifecycle authority generation projection');
  const {
    plan: providedPlan,
    candidate: providedCandidate,
    packageRoot,
    nodeExecutable,
  } = value;
  const plan = exactPlan(providedPlan);
  const candidate = normalizedCandidate(providedCandidate, plan);
  const sourceRoot = absoluteLinuxPath(packageRoot, 'Linux lifecycle authority package source');
  const executableSource = absoluteLinuxPath(nodeExecutable, 'Linux lifecycle authority executable source');
  if (atOrBelow(plan.protectedRoot, sourceRoot) || atOrBelow(plan.protectedRoot, executableSource)) {
    throw new Error('Linux lifecycle authority generation input aliases protected state');
  }
  const manifest = normalizeLinuxLifecycleAuthorityGenerationManifest({
    protocol: GENERATION_PROTOCOL,
    authorityIdentity: plan.authorityIdentity,
    generation: plan.runtime.generation,
    package: candidate.sourceSnapshot,
    node: candidate.node,
  }, plan);
  const directories = new Set(['bin', 'package']);
  const entries = candidate.sourceSnapshot.files.map((entry) => {
    const relative = `package/${entry.relative}`;
    let parent = path.posix.dirname(relative);
    while (parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
    const inputPath = path.posix.join(sourceRoot, entry.relative);
    if (!atOrBelow(sourceRoot, inputPath)) throw new Error('Linux lifecycle authority package input escaped its source');
    return Object.freeze({
      kind: 'transfer',
      relative,
      mode: plan.access.protectedRuntime.fileMode,
      maximumBytes: PROTECTED_AUTHORITY_RUNTIME_BOUNDS.packageFileBytes,
      input: Object.freeze({ path: inputPath, size: entry.size, digest: entry.digest }),
    });
  });
  entries.push(Object.freeze({
    kind: 'transfer',
    relative: 'bin/node',
    mode: plan.access.protectedRuntime.executableMode,
    maximumBytes: PROTECTED_AUTHORITY_RUNTIME_BOUNDS.executableBytes,
    input: Object.freeze({ path: executableSource, size: candidate.node.size, digest: candidate.node.digest }),
  }));
  entries.push(Object.freeze({
    kind: 'content',
    relative: 'generation.json',
    mode: plan.access.protectedRuntime.fileMode,
    maximumBytes: MANIFEST_BYTES,
    content: manifestBytes(manifest),
  }));
  const workingPath = path.posix.join(plan.runtime.stagingDirectory, plan.runtime.generation);
  const rootIds = Object.freeze({ ownerId: 0, groupId: 0 });
  const workingParent = parentContract(plan.runtime.stagingDirectory, plan);
  const installedParent = parentContract(plan.runtime.generationsDirectory, plan);
  return Object.freeze({
    protocol: PROJECTION_PROTOCOL,
    generation: plan.runtime.generation,
    manifest,
    parents: Object.freeze([workingParent, installedParent]),
    tree: Object.freeze({
      working: Object.freeze({ path: workingPath, parent: workingParent.contract }),
      installed: Object.freeze({ path: plan.runtime.generationDirectory, parent: installedParent.contract }),
      ownerId: 0,
      groupId: 0,
      creatorIds: rootIds,
      directoryMode: plan.access.protectedRuntime.directoryMode,
      directories: Object.freeze([...directories].sort((left, right) => depth(left) - depth(right) || codePointCompare(left, right))),
      entries: Object.freeze(entries.sort((left, right) => codePointCompare(left.relative, right.relative))),
    }),
  });
}

export function createLinuxLifecycleAuthorityGenerationVerificationProjection(value = {}) {
  exactKeys(value, new Set(['plan', 'manifest']), 'Linux lifecycle authority generation verification projection');
  const manifest = normalizeLinuxLifecycleAuthorityGenerationManifest(value.manifest, value.plan);
  const plan = validateProjectedPlan(projectLinuxLifecycleAuthorityRuntime(value.plan, {
    packageDigest: manifest.package.digest,
    nodeDigest: manifest.node.digest,
  }));
  const directories = new Set(['bin', 'package']);
  const entries = manifest.package.files.map((entry) => {
    const relative = `package/${entry.relative}`;
    let parent = path.posix.dirname(relative);
    while (parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
    return Object.freeze({
      relative,
      mode: plan.access.protectedRuntime.fileMode,
      maximumBytes: PROTECTED_AUTHORITY_RUNTIME_BOUNDS.packageFileBytes,
      size: entry.size,
      digest: entry.digest,
    });
  });
  entries.push(Object.freeze({
    relative: 'bin/node',
    mode: plan.access.protectedRuntime.executableMode,
    maximumBytes: PROTECTED_AUTHORITY_RUNTIME_BOUNDS.executableBytes,
    size: manifest.node.size,
    digest: manifest.node.digest,
  }));
  const encodedManifest = manifestBytes(manifest);
  entries.push(Object.freeze({
    relative: 'generation.json',
    mode: plan.access.protectedRuntime.fileMode,
    maximumBytes: MANIFEST_BYTES,
    size: encodedManifest.length,
    digest: createHash('sha256').update(encodedManifest).digest('hex'),
  }));
  return Object.freeze({
    protocol: VERIFICATION_PROJECTION_PROTOCOL,
    generation: manifest.generation,
    plan,
    manifest,
    tree: Object.freeze({
      root: Object.freeze({
        path: plan.runtime.generationDirectory,
        ownerId: 0,
        groupId: 0,
        mode: plan.access.protectedRuntime.directoryMode,
      }),
      directoryMode: plan.access.protectedRuntime.directoryMode,
      directories: Object.freeze([...directories].sort((left, right) => depth(left) - depth(right) || codePointCompare(left, right))),
      entries: Object.freeze(entries.sort((left, right) => codePointCompare(left.relative, right.relative))),
    }),
  });
}

export async function verifyLinuxLifecycleAuthorityGeneration(value = {}, providedPorts = {}) {
  const projection = createLinuxLifecycleAuthorityGenerationVerificationProjection(value);
  exactKeys(providedPorts, new Set(['verify']), 'Linux lifecycle authority generation verification ports');
  const verify = providedPorts.verify;
  if (typeof verify !== 'function') throw new TypeError('Linux lifecycle authority generation verification port is invalid');
  const observed = await verify(projection.tree);
  exactKeys(observed, new Set(['path', 'entries', 'ready']), 'Linux lifecycle authority generation verification evidence');
  const expectedEntries = projection.tree.directories.length + projection.tree.entries.length;
  if (observed.path !== projection.plan.runtime.generationDirectory
      || observed.entries !== expectedEntries || observed.ready !== true) {
    throw new Error('Linux lifecycle authority generation verification evidence is invalid');
  }
  return Object.freeze({
    protocol: VERIFICATION_PROTOCOL,
    generation: projection.generation,
    verified: true,
  });
}

function requirePorts(value) {
  exactKeys(value, new Set(['state', 'ensureParents', 'install']), 'Linux lifecycle authority generation ports');
  exactKeys(value.state, new Set(['load', 'save']), 'Linux lifecycle authority generation state port');
  for (const [name, port] of Object.entries({
    load: value.state.load,
    save: value.state.save,
    ensureParents: value.ensureParents,
    install: value.install,
  })) if (typeof port !== 'function') throw new TypeError(`Linux lifecycle authority generation ${name} port is invalid`);
  return value;
}

function changedEvidence(value, name) {
  exactKeys(value, new Set(['changed']), name);
  if (typeof value.changed !== 'boolean') throw new TypeError(`${name} is invalid`);
  return value.changed;
}

function installationEvidence(value, expectedPath) {
  exactKeys(value, new Set(['path', 'entries', 'changed']), 'Linux lifecycle authority generation installation evidence');
  if (value.path !== expectedPath || !Number.isSafeInteger(value.entries) || value.entries < 1 || typeof value.changed !== 'boolean') {
    throw new Error('Linux lifecycle authority generation installation evidence is invalid');
  }
  return Object.freeze({ path: value.path, entries: value.entries, changed: value.changed });
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function stageLinuxLifecycleAuthorityGeneration(value, providedPorts) {
  const ports = requirePorts(providedPorts);
  const projection = createLinuxLifecycleAuthorityGenerationProjection(value);
  const plan = exactPlan(value.plan);
  const loaded = await ports.state.load();
  if (loaded == null) throw new Error('Linux lifecycle authority generation requires an established ownership claim');
  const current = normalizeLinuxLifecycleAuthorityOwnershipRecord(loaded, plan);
  if (current.localIdentity == null) throw new Error('Linux lifecycle authority generation requires an exact numeric identity');
  if (current.stagedGeneration != null && current.stagedGeneration !== projection.generation) {
    throw new Error('Linux lifecycle authority generation conflicts with another staged generation');
  }
  if (current.retainedGenerations.includes(projection.generation)) {
    throw new Error('Linux lifecycle authority generation conflicts with retained state');
  }
  if (current.activeGeneration === projection.generation) {
    throw new Error('Linux lifecycle authority generation is already active and cannot be staged');
  }

  const parentsChanged = changedEvidence(await ports.ensureParents(projection.parents), 'Linux lifecycle authority generation parent evidence');
  const installed = installationEvidence(await ports.install(projection.tree), plan.runtime.generationDirectory);
  if (current.stagedGeneration === projection.generation) {
    return Object.freeze({
      protocol: PROTOCOL,
      generation: projection.generation,
      path: installed.path,
      state: 'staged',
      changed: parentsChanged || installed.changed,
    });
  }

  const target = normalizeLinuxLifecycleAuthorityOwnershipRecord({ ...current, stagedGeneration: projection.generation }, plan);
  const saved = normalizeLinuxLifecycleAuthorityOwnershipRecord(await ports.state.save(target), plan);
  if (!sameRecord(saved, target)) throw new Error('Linux lifecycle authority generation stage record is not exact');
  return Object.freeze({
    protocol: PROTOCOL,
    generation: projection.generation,
    path: installed.path,
    state: 'staged',
    changed: true,
  });
}

export {
  GENERATION_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
  MANIFEST_BYTES as LINUX_LIFECYCLE_AUTHORITY_GENERATION_MANIFEST_MAX_BYTES,
  PROJECTION_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROJECTION_PROTOCOL,
  PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_STAGING_PROTOCOL,
  VERIFICATION_PROJECTION_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROJECTION_PROTOCOL,
  VERIFICATION_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL,
};
