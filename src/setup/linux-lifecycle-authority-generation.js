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
const GENERATION_PROTOCOL = 'devbridge/linux-lifecycle-authority-generation-v1';
const DIGEST = /^[0-9a-f]{64}$/u;
const MANIFEST_BYTES = 32 * 1024;
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

function normalizedCandidate(value, plan) {
  exactKeys(value, new Set(['sourceSnapshot', 'node', 'evidence']), 'Linux lifecycle authority generation candidate');
  exactKeys(value.sourceSnapshot, new Set(['digest', 'files']), 'Linux lifecycle authority package snapshot');
  exactKeys(value.node, new Set(['size', 'digest']), 'Linux lifecycle authority executable evidence');
  exactKeys(value.evidence, new Set(['packageDigest', 'nodeDigest']), 'Linux lifecycle authority candidate evidence');
  const packageDigest = digest(value.sourceSnapshot.digest, 'Linux lifecycle authority package snapshot digest');
  const nodeDigest = digest(value.node.digest, 'Linux lifecycle authority executable digest');
  if (digest(value.evidence.packageDigest, 'Linux lifecycle authority candidate package digest') !== packageDigest
      || digest(value.evidence.nodeDigest, 'Linux lifecycle authority candidate executable digest') !== nodeDigest
      || packageDigest !== plan.runtimeEvidence.packageDigest || nodeDigest !== plan.runtimeEvidence.nodeDigest) {
    throw new Error('Linux lifecycle authority candidate does not match the exact runtime plan');
  }
  if (!Array.isArray(value.sourceSnapshot.files) || value.sourceSnapshot.files.length < 2
      || value.sourceSnapshot.files.length > PROTECTED_AUTHORITY_RUNTIME_BOUNDS.packageFiles) {
    throw new TypeError('Linux lifecycle authority package snapshot files are invalid');
  }
  const files = value.sourceSnapshot.files.map((entry, index) => {
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
  return Object.freeze({
    sourceSnapshot: Object.freeze({ digest: packageDigest, files: Object.freeze(files) }),
    node: Object.freeze({
      size: positive(value.node.size, 'Linux lifecycle authority executable size', PROTECTED_AUTHORITY_RUNTIME_BOUNDS.executableBytes),
      digest: nodeDigest,
    }),
    evidence: Object.freeze({ packageDigest, nodeDigest }),
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
  const plan = exactPlan(providedPlan);
  exactKeys(value, new Set(['protocol', 'authorityIdentity', 'generation', 'packageDigest', 'nodeDigest']), 'Linux lifecycle authority generation record');
  if (value.protocol !== GENERATION_PROTOCOL || value.authorityIdentity !== plan.authorityIdentity
      || digest(value.generation, 'Linux lifecycle authority generation record identity') !== plan.runtime.generation
      || digest(value.packageDigest, 'Linux lifecycle authority package digest') !== plan.runtimeEvidence.packageDigest
      || digest(value.nodeDigest, 'Linux lifecycle authority executable digest') !== plan.runtimeEvidence.nodeDigest) {
    throw new Error('Linux lifecycle authority generation record does not match the exact installation candidate');
  }
  return Object.freeze({
    protocol: GENERATION_PROTOCOL,
    authorityIdentity: plan.authorityIdentity,
    generation: plan.runtime.generation,
    packageDigest: plan.runtimeEvidence.packageDigest,
    nodeDigest: plan.runtimeEvidence.nodeDigest,
  });
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
    packageDigest: candidate.sourceSnapshot.digest,
    nodeDigest: candidate.node.digest,
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
  PROJECTION_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROJECTION_PROTOCOL,
  PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_STAGING_PROTOCOL,
};
