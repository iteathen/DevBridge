import { lstat, open, readFile, readlink, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import { createConfiguredEnvironmentConfigurationClient } from '../runtime/environment-configuration-authority-transport.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { applyLinuxDirectoryDefinition } from './linux-directory-definition-applicator.js';
import { bindLinuxLifecycleAuthorityIdentity } from './linux-lifecycle-authority-identity-binding.js';
import { reconcileLinuxLifecycleAuthorityEndpointTopology } from './linux-lifecycle-authority-endpoint-topology.js';
import {
  createLinuxLifecycleAuthorityGenerationVerificationProjection,
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_MANIFEST_MAX_BYTES,
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL,
  normalizeLinuxLifecycleAuthorityGenerationManifest,
  stageLinuxLifecycleAuthorityGeneration,
  verifyLinuxLifecycleAuthorityGeneration,
} from './linux-lifecycle-authority-generation.js';
import { createLinuxLifecycleAuthorityRecordStore } from './linux-lifecycle-authority-records.js';
import { createLinuxLifecycleAuthorityRefreshMechanics } from './linux-lifecycle-authority-refresh-mechanics.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import { reconcileLinuxLocalIdentityContract } from './linux-local-identity-reconciliation.js';
import {
  ensureLinuxProtectedDirectory,
  inspectLinuxProtectedEntry,
  readLinuxProtectedFile,
  transferLinuxProtectedFile,
  verifyLinuxProtectedFile,
  writeLinuxProtectedFile,
} from './linux-protected-storage.js';
import { installLinuxProtectedTree, verifyLinuxProtectedTree } from './linux-protected-tree.js';
import { reconcileLinuxServiceDefinition } from './linux-service-definition.js';
import { createLinuxServiceManager } from './linux-service-manager.js';
import { LINUX_SERVICE_OBSERVATION_PROTOCOL, observeLinuxService } from './linux-service-observation.js';
import { normalizeProtectedAuthorityReconciliationJournal } from './protected-authority-reconciliation.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-refresh-composition-v1';
const GENERATION = /^[0-9a-f]{64}$/u;
const MAX_GENERATIONS = 11;
const HEALTH_RETRY_DELAYS_MS = Object.freeze([100, 250, 500, 1_000, 2_000]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function exactGeneration(value, name) {
  if (typeof value !== 'string' || !GENERATION.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function exactPlan(value, name, { bound }) {
  if (!value || value.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL) throw new TypeError(`${name} is invalid`);
  if (bound !== (value.runtimeEvidence != null && value.runtime?.generation != null && typeof value.service?.unit === 'string')) {
    throw new TypeError(`${name} binding is invalid`);
  }
  return value;
}

function exactSignal(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || typeof value.aborted !== 'boolean'
      || typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function') {
    throw new TypeError('Linux lifecycle authority refresh cancellation signal is invalid');
  }
  return value;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function boundedReason(error) {
  return String(error?.message ?? error ?? 'health probe failed').replace(/[\r\n]+/gu, ' ').trim().slice(0, 1024) || 'health probe failed';
}

async function syncDirectory(target) {
  const handle = await open(target, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function projectedState(record) {
  if (record == null) return null;
  return Object.freeze({
    bound: record.localIdentity != null,
    activeGeneration: record.activeGeneration,
    stagedGeneration: record.stagedGeneration,
    retainedGenerations: Object.freeze([...record.retainedGenerations]),
  });
}

function transitionFrom(record) {
  if (record?.pending == null) return null;
  return Object.freeze({
    effect: record.pending.effect,
    targetGeneration: record.pending.targetGeneration,
    candidateGeneration: record.candidateGeneration,
    previousGeneration: record.previousGeneration,
    status: record.pending.status,
  });
}

function exactState(value) {
  exactKeys(value, new Set(['bound', 'activeGeneration', 'stagedGeneration', 'retainedGenerations']), 'Linux lifecycle authority projected state');
  if (value.bound !== true) throw new Error('Linux lifecycle authority projected state cannot remove its immutable binding');
  return value;
}

function treePorts({ inspect, ensureDirectory, save, transfer, verifyFile, listDirectory, move, sync }) {
  return Object.freeze({
    observeEntry: (request) => inspect(request),
    ensureDirectory: (request) => ensureDirectory(request),
    writeContent: (request) => save(request),
    transferContent: (request) => transfer(request),
    verifyFile: (request) => verifyFile(request),
    listDirectory,
    move,
    syncDirectory: sync,
  });
}

function verificationPorts({ inspect, verifyFile, listDirectory }) {
  return Object.freeze({
    observeEntry: async (request) => {
      const value = await inspect(request);
      return Object.freeze({ exists: value.exists, kind: value.kind, owner: value.owner, group: value.group, mode: value.mode });
    },
    verifyFile: async (request) => {
      const value = await verifyFile(request);
      return Object.freeze({ ready: value.ready, size: value.size, digest: value.digest });
    },
    listDirectory,
  });
}

export function createLinuxLifecycleAuthorityGenerationSubjects({
  basePlan,
  candidatePlan,
  candidate,
  packageRoot,
  nodeExecutable,
  state,
  ...unknownRequest
} = {}, {
  inspect = inspectLinuxProtectedEntry,
  ensureDirectory = ensureLinuxProtectedDirectory,
  load = readLinuxProtectedFile,
  save = writeLinuxProtectedFile,
  transfer = transferLinuxProtectedFile,
  verifyFile = verifyLinuxProtectedFile,
  listDirectory = readdir,
  move = rename,
  sync = syncDirectory,
  install = installLinuxProtectedTree,
  verifyTree = verifyLinuxProtectedTree,
  stage = stageLinuxLifecycleAuthorityGeneration,
  verify = verifyLinuxLifecycleAuthorityGeneration,
  ...unknownPorts
} = {}) {
  if (Object.keys(unknownRequest).length > 0) throw new TypeError('Linux lifecycle authority subject request contains an unknown field');
  if (Object.keys(unknownPorts).length > 0) throw new TypeError('Linux lifecycle authority subject ports contain an unknown field');
  const base = exactPlan(basePlan, 'Linux lifecycle authority subject base plan', { bound: false });
  const selected = exactPlan(candidatePlan, 'Linux lifecycle authority subject candidate plan', { bound: true });
  if (base.authorityIdentity !== selected.authorityIdentity || base.protectedRoot !== selected.protectedRoot) {
    throw new Error('Linux lifecycle authority subject plans do not describe one installation');
  }
  if (!candidate || candidate.evidence?.packageDigest !== selected.runtimeEvidence.packageDigest
      || candidate.evidence?.nodeDigest !== selected.runtimeEvidence.nodeDigest) {
    throw new TypeError('Linux lifecycle authority subject candidate evidence is invalid');
  }
  if (typeof packageRoot !== 'string' || typeof nodeExecutable !== 'string') throw new TypeError('Linux lifecycle authority subject sources are invalid');
  if (!state || typeof state.load !== 'function' || typeof state.save !== 'function') throw new TypeError('Linux lifecycle authority subject state is invalid');
  for (const [name, port] of Object.entries({ inspect, ensureDirectory, load, save, transfer, verifyFile, listDirectory, move, sync, install, verifyTree, stage, verify })) {
    if (typeof port !== 'function') throw new TypeError(`Linux lifecycle authority subject ${name} port is invalid`);
  }
  const generationTreePorts = treePorts({ inspect, ensureDirectory, save, transfer, verifyFile, listDirectory, move, sync });
  const generationVerificationPorts = verificationPorts({ inspect, verifyFile, listDirectory });

  async function names() {
    let values;
    try { values = await listDirectory(base.runtime.generationsDirectory); }
    catch (error) { if (error?.code === 'ENOENT') return Object.freeze([]); throw error; }
    if (!Array.isArray(values) || values.length > MAX_GENERATIONS) throw new Error('Linux lifecycle authority generation catalog is outside its bound');
    const normalized = values.map((entry) => exactGeneration(entry, 'Linux lifecycle authority generation catalog entry')).sort();
    if (new Set(normalized).size !== normalized.length) throw new Error('Linux lifecycle authority generation catalog is ambiguous');
    return Object.freeze(normalized);
  }

  async function resolve(generation) {
    const identity = exactGeneration(generation, 'Linux lifecycle authority generation subject');
    const contract = Object.freeze({
      path: path.posix.join(base.runtime.generationsDirectory, identity, 'generation.json'),
      ownerId: 0,
      groupId: 0,
      mode: base.access.protectedRuntime.fileMode,
    });
    const observed = await inspect({ contract, kind: 'file' });
    if (!observed.exists) return null;
    if (!(observed.kind && observed.owner && observed.group && observed.mode)) throw new Error('Linux lifecycle authority generation manifest policy is invalid');
    const loaded = await load({
      contract,
      maximumBytes: LINUX_LIFECYCLE_AUTHORITY_GENERATION_MANIFEST_MAX_BYTES,
    });
    let raw;
    try { raw = JSON.parse(loaded.content.toString('utf8')); }
    catch { throw new Error('Linux lifecycle authority generation manifest is invalid JSON'); }
    const manifest = normalizeLinuxLifecycleAuthorityGenerationManifest(raw, base);
    if (manifest.generation !== identity) throw new Error('Linux lifecycle authority generation manifest identity changed');
    const evidence = await verify({ plan: base, manifest }, {
      verify: async (request) => {
        const result = await verifyTree(request, generationVerificationPorts);
        return Object.freeze({ path: result.path, entries: result.entries, ready: result.ready });
      },
    });
    if (evidence.protocol !== LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL
        || evidence.generation !== identity || evidence.verified !== true) {
      throw new Error('Linux lifecycle authority generation subject is not exact');
    }
    const projection = createLinuxLifecycleAuthorityGenerationVerificationProjection({ plan: base, manifest });
    return Object.freeze({ generation: identity, manifest, plan: projection.plan });
  }

  return Object.freeze({
    resolve,
    async observe(value) {
      exactKeys(value, new Set(['generations']), 'Linux lifecycle authority subject observation request');
      if (!Array.isArray(value.generations) || value.generations.length > MAX_GENERATIONS) throw new TypeError('Linux lifecycle authority subject observation generations are invalid');
      const admitted = value.generations.map((entry) => exactGeneration(entry, 'Linux lifecycle authority admitted generation'));
      if (new Set(admitted).size !== admitted.length) throw new TypeError('Linux lifecycle authority admitted generations are ambiguous');
      const installed = await names();
      const present = [];
      for (const identity of installed) {
        await resolve(identity);
        if (admitted.includes(identity)) present.push(identity);
      }
      return Object.freeze({ presentGenerations: Object.freeze(present), exact: installed.every((identity) => admitted.includes(identity)) });
    },
    async stage(value) {
      exactKeys(value, new Set(['generation']), 'Linux lifecycle authority subject stage request');
      const identity = exactGeneration(value.generation, 'Linux lifecycle authority staged generation');
      if (identity !== selected.runtime.generation) throw new Error('Linux lifecycle authority can stage only the measured candidate');
      await stage({ plan: selected, candidate, packageRoot, nodeExecutable }, {
        state,
        async ensureParents(parents) {
          let changed = false;
          for (const parent of parents) changed = (await ensureDirectory(parent)).changed || changed;
          return Object.freeze({ changed });
        },
        install: (request) => install(request, generationTreePorts),
      });
      const installed = await resolve(identity);
      if (installed == null) throw new Error('Linux lifecycle authority staged generation is not observable');
      return Object.freeze({ generation: identity, ready: true });
    },
    async verify(value) {
      exactKeys(value, new Set(['generation']), 'Linux lifecycle authority subject verification request');
      const identity = exactGeneration(value.generation, 'Linux lifecycle authority verified generation');
      try { return Object.freeze({ generation: identity, verified: await resolve(identity) != null }); }
      catch { return Object.freeze({ generation: identity, verified: false }); }
    },
  });
}

function parseProcessStatus(value) {
  const fields = new Map();
  for (const line of String(value).split('\n')) {
    const match = /^(Uid|Gid|Groups):\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    if (fields.has(match[1])) throw new Error('Linux lifecycle authority process identity is ambiguous');
    const entries = match[2].split(/\s+/u).filter(Boolean).map((entry) => {
      if (!/^\d+$/u.test(entry)) throw new Error('Linux lifecycle authority process identity is invalid');
      const number = Number.parseInt(entry, 10);
      if (!Number.isSafeInteger(number) || number < 0) throw new Error('Linux lifecycle authority process identity is invalid');
      return number;
    });
    fields.set(match[1], entries);
  }
  if (fields.get('Uid')?.length !== 4 || fields.get('Gid')?.length !== 4 || !fields.has('Groups')) {
    throw new Error('Linux lifecycle authority process identity is incomplete');
  }
  return Object.freeze({ uids: fields.get('Uid'), gids: fields.get('Gid'), groups: fields.get('Groups').sort((left, right) => left - right) });
}

export function createLinuxLifecycleAuthorityActivity({ plan, state, subjects, signal = null, ...unknownRequest } = {}, {
  inspect = inspectLinuxProtectedEntry,
  load = readLinuxProtectedFile,
  observe = observeLinuxService,
  actions = createLinuxServiceManager,
  loadProcess = readFile,
  linkProcess = readlink,
  invoke = invokeCommand,
  ...unknownPorts
} = {}) {
  if (Object.keys(unknownRequest).length > 0) throw new TypeError('Linux lifecycle authority activity request contains an unknown field');
  if (Object.keys(unknownPorts).length > 0) throw new TypeError('Linux lifecycle authority activity ports contain an unknown field');
  const selected = exactPlan(plan, 'Linux lifecycle authority activity plan', { bound: true });
  const cancellation = exactSignal(signal);
  if (!state || typeof state.load !== 'function' || !subjects || typeof subjects.resolve !== 'function') {
    throw new TypeError('Linux lifecycle authority activity connections are invalid');
  }
  for (const [name, port] of Object.entries({ inspect, load, observe, actions, loadProcess, linkProcess, invoke })) {
    if (typeof port !== 'function') throw new TypeError(`Linux lifecycle authority activity ${name} port is invalid`);
  }
  const manager = actions({ unit: selected.service.name, platform: 'linux', invoke, signal: cancellation });
  if (!manager || manager.applicable !== true || typeof manager.quiesce !== 'function' || typeof manager.activate !== 'function') {
    throw new Error('Linux lifecycle authority activity actions are unavailable');
  }

  async function inspectActivity(value) {
    exactKeys(value, new Set(['generations']), 'Linux lifecycle authority activity observation request');
    if (!Array.isArray(value.generations) || value.generations.length > MAX_GENERATIONS) throw new TypeError('Linux lifecycle authority activity generations are invalid');
    const plans = new Map();
    for (const generation of value.generations) {
      const identity = exactGeneration(generation, 'Linux lifecycle authority activity generation');
      if (plans.has(identity)) throw new TypeError('Linux lifecycle authority activity generations are ambiguous');
      const subject = await subjects.resolve(identity);
      if (subject != null) plans.set(identity, subject.plan);
    }
    const contract = Object.freeze({ path: selected.service.unitPath, ownerId: 0, groupId: 0, mode: 0o644 });
    const file = await inspect({ contract, kind: 'file' });
    const service = await observe({ unit: selected.service.name, platform: 'linux', signal: cancellation }, { invoke });
    if (!service || service.protocol !== LINUX_SERVICE_OBSERVATION_PROTOCOL || service.applicable !== true || service.observable !== true) {
      throw new Error('Linux lifecycle authority activity is not observable');
    }
    if (!file.exists) {
      if (service.exists) throw new Error('Linux lifecycle authority activity definition is missing');
      return Object.freeze({ exists: false, running: false, configuredGeneration: null, processGeneration: null });
    }
    if (!(file.kind && file.owner && file.group && file.mode)) throw new Error('Linux lifecycle authority activity definition policy is invalid');
    const content = (await load({ contract, maximumBytes: 64 * 1024 })).content.toString('utf8');
    const configured = [...plans.entries()].filter(([, projected]) => projected.service.unit === content).map(([generation]) => generation);
    if (configured.length !== 1) throw new Error('Linux lifecycle authority activity definition is foreign or ambiguous');
    const configuredGeneration = configured[0];
    if (service.exists) {
      const expected = plans.get(configuredGeneration);
      if (service.fragmentPath !== selected.service.unitPath || service.user !== selected.service.user
          || service.group !== selected.service.readGroup
          || !sameSet(service.supplementaryGroups, [selected.service.coordinationGroup, selected.service.managementGroup])
          || service.type !== 'exec' || service.dropIns) {
        throw new Error('Linux lifecycle authority loaded activity identity is foreign');
      }
      if (expected.service.name !== selected.service.name) throw new Error('Linux lifecycle authority activity subject changed its local name');
    }
    if ((service.activeState === 'active') !== (service.mainPid > 0)) {
      throw new Error('Linux lifecycle authority manager process state is inconsistent');
    }
    const running = service.exists && service.activeState === 'active' && service.mainPid > 0;
    if (!running) return Object.freeze({ exists: true, running: false, configuredGeneration, processGeneration: null });
    const ownership = await state.load();
    if (ownership?.localIdentity == null) throw new Error('Linux lifecycle authority process identity is unbound');
    const status = parseProcessStatus(await loadProcess(`/proc/${service.mainPid}/status`, 'utf8'));
    const identity = ownership.localIdentity;
    if (!status.uids.every((entry) => entry === identity.serviceUid)
        || !status.gids.every((entry) => entry === identity.readGid)
        || !sameSet(status.groups, [identity.readGid, identity.coordinationGid, identity.managementGid].sort((left, right) => left - right))) {
      throw new Error('Linux lifecycle authority running process identity is foreign');
    }
    const executable = await linkProcess(`/proc/${service.mainPid}/exe`);
    const processes = [...plans.entries()].filter(([, projected]) => projected.runtime.nodeExecutable === executable).map(([generation]) => generation);
    if (processes.length !== 1 || processes[0] !== configuredGeneration) throw new Error('Linux lifecycle authority running process generation is foreign');
    return Object.freeze({ exists: true, running: true, configuredGeneration, processGeneration: processes[0] });
  }

  return Object.freeze({
    inspect: inspectActivity,
    async quiesce(value) {
      exactKeys(value, new Set(['generation']), 'Linux lifecycle authority activity quiesce request');
      const generation = exactGeneration(value.generation, 'Linux lifecycle authority quiesce generation');
      if (await subjects.resolve(generation) == null) throw new Error('Linux lifecycle authority quiesce subject is unavailable');
      await manager.quiesce();
      return Object.freeze({ generation, ready: true });
    },
    async activate(value) {
      exactKeys(value, new Set(['generation']), 'Linux lifecycle authority activity activation request');
      const generation = exactGeneration(value.generation, 'Linux lifecycle authority activation generation');
      if (await subjects.resolve(generation) == null) throw new Error('Linux lifecycle authority activation subject is unavailable');
      await manager.activate();
      return Object.freeze({ generation, ready: true });
    },
  });
}

export async function probeLinuxLifecycleAuthority({ plan, ...unknownRequest } = {}, {
  clientFactory = createConfiguredLifecycleAuthorityClient,
  configurationClientFactory = createConfiguredEnvironmentConfigurationClient,
  waitForRetry = wait,
  ...unknownPorts
} = {}) {
  if (Object.keys(unknownRequest).length > 0) throw new TypeError('Linux lifecycle authority health request contains an unknown field');
  if (Object.keys(unknownPorts).length > 0) throw new TypeError('Linux lifecycle authority health ports contain an unknown field');
  const selected = exactPlan(plan, 'Linux lifecycle authority health plan', { bound: true });
  if (typeof clientFactory !== 'function' || typeof configurationClientFactory !== 'function' || typeof waitForRetry !== 'function') {
    throw new TypeError('Linux lifecycle authority health ports are invalid');
  }
  let lastError = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const client = clientFactory({
        stateDirectory: selected.stateDirectory,
        platform: 'linux',
        runDirectory: selected.endpoints.parentDirectory,
        connectTimeoutMs: 3_000,
      });
      const result = await client.inspect();
      if (!result || result.protocol !== 'devbridge/environment-operator-v1') throw new Error('protected lifecycle authority returned invalid inspection evidence');
      const configurationClient = configurationClientFactory({
        stateDirectory: selected.stateDirectory,
        platform: 'linux',
        runDirectory: selected.endpoints.parentDirectory,
        connectTimeoutMs: 3_000,
      });
      const configuration = await configurationClient.inspect();
      if (configuration?.ready !== true || Object.keys(configuration).length !== 1) {
        throw new Error('protected environment configuration authority returned invalid inspection evidence');
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= HEALTH_RETRY_DELAYS_MS.length) throw lastError;
      await waitForRetry(HEALTH_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function createLinuxLifecycleAuthorityRefreshComposition({
  basePlan,
  candidatePlan,
  candidate,
  packageRoot,
  nodeExecutable,
  admitClaim,
  signal = null,
  invoke = invokeCommand,
  environment = process.env,
  ...unknownRequest
} = {}, {
  createRecords = createLinuxLifecycleAuthorityRecordStore,
  bindIdentity = bindLinuxLifecycleAuthorityIdentity,
  reconcileIdentity = reconcileLinuxLocalIdentityContract,
  ensureDirectory = ensureLinuxProtectedDirectory,
  ensureEndpoints = reconcileLinuxLifecycleAuthorityEndpointTopology,
  ensureDefinition = reconcileLinuxServiceDefinition,
  createSubjects = createLinuxLifecycleAuthorityGenerationSubjects,
  createActivity = createLinuxLifecycleAuthorityActivity,
  probe = probeLinuxLifecycleAuthority,
  stat = lstat,
  ...unknownPorts
} = {}) {
  if (Object.keys(unknownRequest).length > 0) throw new TypeError('Linux lifecycle authority composition request contains an unknown field');
  if (Object.keys(unknownPorts).length > 0) throw new TypeError('Linux lifecycle authority composition ports contain an unknown field');
  const base = exactPlan(basePlan, 'Linux lifecycle authority composition base plan', { bound: false });
  const selected = exactPlan(candidatePlan, 'Linux lifecycle authority composition candidate plan', { bound: true });
  const cancellation = exactSignal(signal);
  if (base.authorityIdentity !== selected.authorityIdentity || base.protectedRoot !== selected.protectedRoot) {
    throw new Error('Linux lifecycle authority composition plans do not describe one installation');
  }
  if (typeof admitClaim !== 'function' || typeof invoke !== 'function') throw new TypeError('Linux lifecycle authority composition authority ports are invalid');
  for (const [name, port] of Object.entries({ createRecords, bindIdentity, reconcileIdentity, ensureDirectory, ensureEndpoints, ensureDefinition, createSubjects, createActivity, probe, stat })) {
    if (typeof port !== 'function') throw new TypeError(`Linux lifecycle authority composition ${name} port is invalid`);
  }
  const records = createRecords({ plan: selected, admitClaim, normalizeTransaction: normalizeProtectedAuthorityReconciliationJournal });
  if (!records?.claim || typeof records.claim.ensure !== 'function' || !records.ownership || !records.journal) {
    throw new Error('Linux lifecycle authority composition record store is incomplete');
  }
  await records.claim.ensure();
  await bindIdentity({ plan: selected }, {
    state: records.ownership,
    reconcile: (request) => reconcileIdentity({ ...request, platform: 'linux', invoke, environment }),
  });

  const state = Object.freeze({
    load: async () => projectedState(await records.ownership.load()),
    async save(value) {
      const target = exactState(value);
      const current = await records.ownership.load();
      if (current?.localIdentity == null) throw new Error('Linux lifecycle authority composition state is unbound');
      const saved = await records.ownership.save(Object.freeze({
        ...current,
        activeGeneration: target.activeGeneration,
        stagedGeneration: target.stagedGeneration,
        retainedGenerations: Object.freeze([...target.retainedGenerations]),
      }));
      return projectedState(saved);
    },
  });
  const subjects = createSubjects({ basePlan: base, candidatePlan: selected, candidate, packageRoot, nodeExecutable, state: records.ownership });
  const activity = createActivity({ plan: selected, state: records.ownership, subjects, signal: cancellation }, { invoke });

  async function prepare(value) {
    exactKeys(value, new Set(['generation']), 'Linux lifecycle authority preparation request');
    const generation = exactGeneration(value.generation, 'Linux lifecycle authority preparation generation');
    const ownership = await records.ownership.load();
    if (ownership?.localIdentity == null) throw new Error('Linux lifecycle authority preparation identity is unbound');
    const protectedParent = Object.freeze({ path: selected.protectedRoot, ownerId: 0, groupId: 0, mode: selected.access.protectedRoot.mode });
    const authority = await stat(selected.authorityDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    await ensureDirectory({
      contract: Object.freeze({ path: selected.authorityDirectory, ownerId: ownership.localIdentity.serviceUid, groupId: 0, mode: selected.access.authorityState.mode }),
      parent: protectedParent,
      adoptOwnerIds: authority == null ? [0] : [],
      adoptGroupIds: authority == null ? [0] : [],
    });
    const endpoint = await ensureEndpoints({ plan: selected, platform: 'linux', signal: cancellation }, {
      state: records.ownership,
      apply: (request) => applyLinuxDirectoryDefinition(request, { invoke }),
    });
    if (endpoint?.ready !== true) throw new Error('Linux lifecycle authority endpoint preparation is incomplete');
    return Object.freeze({ generation, ready: true });
  }

  async function definition(value) {
    exactKeys(value, new Set(['generation', 'acceptedGenerations']), 'Linux lifecycle authority definition request');
    const generation = exactGeneration(value.generation, 'Linux lifecycle authority definition generation');
    if (!Array.isArray(value.acceptedGenerations) || value.acceptedGenerations.length > 1) throw new TypeError('Linux lifecycle authority accepted definitions are invalid');
    const target = await subjects.resolve(generation);
    if (target == null) throw new Error('Linux lifecycle authority definition subject is unavailable');
    const accepted = [];
    for (const previous of value.acceptedGenerations) {
      const subject = await subjects.resolve(exactGeneration(previous, 'Linux lifecycle authority accepted generation'));
      if (subject == null) throw new Error('Linux lifecycle authority accepted definition subject is unavailable');
      accepted.push(subject.plan.service.unit);
    }
    const result = await ensureDefinition({
      name: selected.service.name,
      path: selected.service.unitPath,
      definition: target.plan.service.unit,
      acceptedDefinitions: accepted,
      expected: Object.freeze({
        user: selected.service.user,
        group: selected.service.readGroup,
        supplementaryGroups: Object.freeze([selected.service.coordinationGroup, selected.service.managementGroup]),
        type: 'exec',
      }),
      platform: 'linux',
      signal: cancellation,
    }, {
      observe: (request) => observeLinuxService(request, { invoke }),
      actions: (request) => createLinuxServiceManager({ ...request, invoke }),
    });
    if (result?.ready !== true) throw new Error('Linux lifecycle authority definition reconciliation is incomplete');
    return Object.freeze({ generation, ready: true });
  }

  const mechanics = createLinuxLifecycleAuthorityRefreshMechanics({
    candidateGeneration: selected.runtime.generation,
    ports: Object.freeze({
      journal: records.journal,
      transition: Object.freeze({ load: async () => transitionFrom(await records.journal.load()) }),
      state,
      subjects: Object.freeze({ observe: subjects.observe, stage: subjects.stage, verify: subjects.verify }),
      preparation: Object.freeze({ ensure: prepare }),
      definition: Object.freeze({ ensure: definition }),
      activity,
      probe: async (value) => {
        exactKeys(value, new Set(['generation']), 'Linux lifecycle authority probe request');
        const generation = exactGeneration(value.generation, 'Linux lifecycle authority probe generation');
        const subject = await subjects.resolve(generation);
        if (subject == null) return Object.freeze({ generation, ready: false, reason: 'generation is unavailable' });
        try {
          await probe({ plan: subject.plan });
          return Object.freeze({ generation, ready: true, reason: null });
        } catch (error) {
          return Object.freeze({ generation, ready: false, reason: boundedReason(error) });
        }
      },
    }),
  });
  return Object.freeze({ protocol: PROTOCOL, generation: selected.runtime.generation, mechanics });
}

export { PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_REFRESH_COMPOSITION_PROTOCOL };
