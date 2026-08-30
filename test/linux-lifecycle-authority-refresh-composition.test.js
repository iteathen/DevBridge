import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  bindLinuxLifecycleAuthorityRuntime,
  createLinuxLifecycleAuthorityPlan,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  createLinuxLifecycleAuthorityGenerationProjection,
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-generation.js';
import {
  createLinuxLifecycleAuthorityActivity,
  createLinuxLifecycleAuthorityGenerationSubjects,
  createLinuxLifecycleAuthorityRefreshComposition,
  LINUX_LIFECYCLE_AUTHORITY_REFRESH_COMPOSITION_PROTOCOL,
  probeLinuxLifecycleAuthority,
} from '../src/setup/linux-lifecycle-authority-refresh-composition.js';
import { reconcileLinuxLifecycleAuthorityRefresh } from '../src/setup/linux-lifecycle-authority-refresh-adapter.js';
import { LINUX_SERVICE_OBSERVATION_PROTOCOL } from '../src/setup/linux-service-observation.js';

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

function values(content = 'export const generation = 1;\n') {
  const candidate = candidateFrom({
    'package.json': '{"name":"devbridge"}\n',
    'src/app/example.js': content,
    'src/entry/linux-lifecycle-authority-service.mjs': 'export const service = true;\n',
  });
  const base = createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/state/devbridge',
    operatorName: 'operator',
    managementGroup: Object.freeze({ name: 'virt_control', id: 1104 }),
  });
  const plan = bindLinuxLifecycleAuthorityRuntime(base, candidate.evidence);
  return Object.freeze({
    base,
    candidate,
    plan,
  });
}

function serviceObservation(plan, overrides = {}) {
  const exists = overrides.exists ?? true;
  return Object.freeze({
    protocol: LINUX_SERVICE_OBSERVATION_PROTOCOL,
    platform: 'linux',
    applicable: true,
    observable: true,
    exists,
    reason: null,
    loadState: exists ? 'loaded' : 'not-found',
    activeState: exists ? 'active' : 'inactive',
    subState: exists ? 'running' : 'dead',
    mainPid: exists ? 41 : 0,
    fragmentPath: exists ? plan.service.unitPath : '',
    user: exists ? plan.service.user : '',
    group: exists ? plan.service.readGroup : '',
    supplementaryGroups: exists ? Object.freeze([plan.service.coordinationGroup, String(plan.service.managementGroupId)]) : Object.freeze([]),
    type: exists ? 'exec' : '',
    unitFileState: exists ? 'enabled' : '',
    needsReload: false,
    dropIns: false,
    definitionCurrent: exists,
    ...overrides,
  });
}

test('generation subjects resolve exact self-describing generations and report undeclared installed state', async () => {
  const current = values();
  const historical = values('export const generation = 0;\n');
  const currentManifest = createLinuxLifecycleAuthorityGenerationProjection({
    plan: current.plan,
    candidate: current.candidate,
    packageRoot: '/source/package',
    nodeExecutable: '/source/node',
  }).manifest;
  const historicalManifest = createLinuxLifecycleAuthorityGenerationProjection({
    plan: historical.plan,
    candidate: historical.candidate,
    packageRoot: '/source/package',
    nodeExecutable: '/source/node',
  }).manifest;
  const manifests = new Map([
    [current.plan.runtime.generation, currentManifest],
    [historical.plan.runtime.generation, historicalManifest],
  ]);
  let installed = [current.plan.runtime.generation];
  const subjects = createLinuxLifecycleAuthorityGenerationSubjects({
    basePlan: current.base,
    candidatePlan: current.plan,
    candidate: current.candidate,
    packageRoot: '/source/package',
    nodeExecutable: '/source/node',
    state: Object.freeze({ load: async () => ({}), save: async (value) => value }),
  }, {
    inspect: async ({ contract }) => Object.freeze({ exists: manifests.has(contract.path.split('/').at(-2)), kind: true, owner: true, group: true, mode: true }),
    ensureDirectory: async () => Object.freeze({ changed: false }),
    load: async ({ contract }) => {
      const manifest = manifests.get(contract.path.split('/').at(-2));
      const content = Buffer.from(`${JSON.stringify(manifest)}\n`);
      return Object.freeze({ content, size: content.length });
    },
    save: async () => ({}),
    transfer: async () => ({}),
    verifyFile: async () => ({}),
    listDirectory: async () => installed,
    move: async () => {},
    sync: async () => {},
    install: async () => ({}),
    verifyTree: async () => ({}),
    stage: async () => { installed = [current.plan.runtime.generation]; },
    verify: async ({ manifest }) => Object.freeze({
      protocol: LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL,
      generation: manifest.generation,
      verified: true,
    }),
  });

  assert.deepEqual(await subjects.observe({ generations: [current.plan.runtime.generation] }), {
    presentGenerations: [current.plan.runtime.generation],
    exact: true,
  });
  assert.equal((await subjects.resolve(current.plan.runtime.generation)).plan.service.unit, current.plan.service.unit);

  installed = [current.plan.runtime.generation, historical.plan.runtime.generation].sort();
  assert.deepEqual(await subjects.observe({ generations: [current.plan.runtime.generation] }), {
    presentGenerations: [current.plan.runtime.generation],
    exact: false,
  });
  installed = ['foreign'];
  await assert.rejects(() => subjects.observe({ generations: [current.plan.runtime.generation] }), /catalog entry is invalid/u);
});

test('activity binds exact stored definition, loaded identity, numeric process identity, and executable generation', async () => {
  const selected = values();
  const identity = Object.freeze({ serviceUid: 1101, operatorUid: 1100, readGid: 1102, coordinationGid: 1103, managementGid: 1104 });
  const processStatus = `Uid:\t1101\t1101\t1101\t1101\nGid:\t1102\t1102\t1102\t1102\nGroups:\t1102 1103 1104\n`;
  const state = Object.freeze({ load: async () => Object.freeze({ localIdentity: identity }) });
  const subjects = Object.freeze({ resolve: async (generation) => generation === selected.plan.runtime.generation ? Object.freeze({ plan: selected.plan }) : null });
  const basePorts = {
    inspect: async () => Object.freeze({ exists: true, kind: true, owner: true, group: true, mode: true }),
    load: async () => Object.freeze({ content: Buffer.from(selected.plan.service.unit), size: Buffer.byteLength(selected.plan.service.unit) }),
    observe: async () => serviceObservation(selected.plan),
    actions: () => Object.freeze({ applicable: true, quiesce: async () => true, activate: async () => true }),
    loadProcess: async () => processStatus,
    linkProcess: async () => selected.plan.runtime.nodeExecutable,
    invoke: async () => ({}),
  };
  const activity = createLinuxLifecycleAuthorityActivity({ plan: selected.plan, state, subjects }, basePorts);
  assert.deepEqual(await activity.inspect({ generations: [selected.plan.runtime.generation] }), {
    exists: true,
    running: true,
    configuredGeneration: selected.plan.runtime.generation,
    processGeneration: selected.plan.runtime.generation,
  });
  assert.deepEqual(await activity.quiesce({ generation: selected.plan.runtime.generation }), { generation: selected.plan.runtime.generation, ready: true });
  await assert.rejects(() => activity.activate({ generation: 'f'.repeat(64) }), /activation subject is unavailable/u);
  await assert.rejects(() => activity.inspect({ generations: [selected.plan.runtime.generation, selected.plan.runtime.generation] }), /generations are ambiguous/u);

  const foreignProcess = createLinuxLifecycleAuthorityActivity({ plan: selected.plan, state, subjects }, {
    ...basePorts,
    linkProcess: async () => '/foreign/node',
  });
  await assert.rejects(() => foreignProcess.inspect({ generations: [selected.plan.runtime.generation] }), /process generation is foreign/u);
  const foreignDropIn = createLinuxLifecycleAuthorityActivity({ plan: selected.plan, state, subjects }, {
    ...basePorts,
    observe: async () => serviceObservation(selected.plan, { dropIns: true, definitionCurrent: false }),
  });
  await assert.rejects(() => foreignDropIn.inspect({ generations: [selected.plan.runtime.generation] }), /loaded activity identity is foreign/u);
});

test('health retries local IPC and requires the exact operator protocol', async () => {
  const selected = values();
  let attempts = 0;
  const waits = [];
  const result = await probeLinuxLifecycleAuthority({ plan: selected.plan }, {
    clientFactory: () => Object.freeze({
      async inspect() {
        attempts += 1;
        if (attempts < 3) throw new Error('not listening');
        return Object.freeze({ protocol: 'devbridge/environment-operator-v1', ready: true });
      },
    }),
    configurationClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: true }) }),
    activityClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: false, identity: 'foundation-a', reason: 'environment activity is unavailable' }) }),
    waitForRetry: async (delay) => { waits.push(delay); },
  });
  assert.equal(result.protocol, 'devbridge/environment-operator-v1');
  assert.deepEqual(waits, [100, 250]);
  await assert.rejects(() => probeLinuxLifecycleAuthority({ plan: selected.plan }, {
    clientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ protocol: 'foreign' }) }),
    configurationClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: true }) }),
    activityClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: true, identity: 'foundation-a', reason: null }) }),
    waitForRetry: async () => {},
  }), /invalid inspection evidence/u);
  await assert.rejects(() => probeLinuxLifecycleAuthority({ plan: selected.plan }, {
    clientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ protocol: 'devbridge/environment-operator-v1' }) }),
    configurationClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: true, widened: true }) }),
    activityClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: true, identity: 'foundation-a', reason: null }) }),
    waitForRetry: async () => {},
  }), /configuration authority returned invalid inspection evidence/u);
  await assert.rejects(() => probeLinuxLifecycleAuthority({ plan: selected.plan }, {
    clientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ protocol: 'devbridge/environment-operator-v1' }) }),
    configurationClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: true }) }),
    activityClientFactory: () => Object.freeze({ inspect: async () => Object.freeze({ ready: true, identity: 'foundation-a', reason: null, widened: true }) }),
    waitForRetry: async () => {},
  }), /activity authority returned invalid inspection evidence/u);
});

test('composition connects concrete ownership to neutral mechanics and reaches exact fresh/no-op reconciliation', async () => {
  const selected = values();
  let ownership = Object.freeze({
    localIdentity: null,
    activeGeneration: null,
    stagedGeneration: null,
    retainedGenerations: Object.freeze([]),
  });
  let journal = null;
  const installed = new Set();
  const effects = [];
  let identityBinding = null;
  const localActivity = { exists: false, running: false, configuredGeneration: null, processGeneration: null };
  const records = Object.freeze({
    claim: Object.freeze({ ensure: async () => ownership }),
    ownership: Object.freeze({
      load: async () => ownership,
      save: async (value) => { ownership = Object.freeze({ ...value, retainedGenerations: Object.freeze([...value.retainedGenerations]) }); return ownership; },
    }),
    journal: Object.freeze({
      load: async () => journal,
      save: async (value) => { journal = structuredClone(value); return journal; },
    }),
  });
  const subjects = Object.freeze({
    resolve: async (generation) => generation === selected.plan.runtime.generation && installed.has(generation) ? Object.freeze({ plan: selected.plan }) : null,
    async observe({ generations }) {
      const presentGenerations = [...installed].filter((generation) => generations.includes(generation));
      return Object.freeze({ presentGenerations, exact: [...installed].every((generation) => generations.includes(generation)) });
    },
    async stage({ generation }) { effects.push('stage'); installed.add(generation); return Object.freeze({ generation, ready: true }); },
    async verify({ generation }) { return Object.freeze({ generation, verified: installed.has(generation) }); },
  });
  const activity = Object.freeze({
    inspect: async () => Object.freeze({ ...localActivity }),
    async quiesce({ generation }) { effects.push('quiesce'); localActivity.running = false; localActivity.processGeneration = null; return Object.freeze({ generation, ready: true }); },
    async activate({ generation }) { effects.push('activate'); localActivity.running = true; localActivity.processGeneration = generation; return Object.freeze({ generation, ready: true }); },
  });
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const composition = await createLinuxLifecycleAuthorityRefreshComposition({
    basePlan: selected.base,
    candidatePlan: selected.plan,
    candidate: selected.candidate,
    packageRoot: '/source/package',
    nodeExecutable: '/source/node',
    admitClaim: async () => true,
  }, {
    createRecords: () => records,
    bindIdentity: async (request) => {
      identityBinding = structuredClone(request);
      ownership = Object.freeze({ ...ownership, localIdentity: Object.freeze({ serviceUid: 1101, operatorUid: 1100, readGid: 1102, coordinationGid: 1103, managementGid: 1104 }) });
    },
    reconcileIdentity: async () => ({}),
    ensureDirectory: async (request) => { effects.push(`directory:${request.contract.path}`); return Object.freeze({ changed: true }); },
    ensureEndpoints: async () => { effects.push('endpoints'); return Object.freeze({ ready: true }); },
    ensureDefinition: async ({ definition }) => {
      effects.push('definition');
      assert.equal(definition, selected.plan.service.unit);
      localActivity.exists = true;
      localActivity.configuredGeneration = selected.plan.runtime.generation;
      return Object.freeze({ ready: true });
    },
    createSubjects: () => subjects,
    createActivity: () => activity,
    probe: async () => { effects.push('probe'); return Object.freeze({ protocol: 'devbridge/environment-operator-v1' }); },
    stat: async () => { throw missing(); },
  });
  assert.equal(composition.protocol, LINUX_LIFECYCLE_AUTHORITY_REFRESH_COMPOSITION_PROTOCOL);
  assert.deepEqual(Object.keys(composition).sort(), ['generation', 'mechanics', 'protocol']);
  assert.deepEqual(identityBinding, { plan: selected.plan });

  const first = await reconcileLinuxLifecycleAuthorityRefresh({ candidateGeneration: selected.plan.runtime.generation, mechanics: composition.mechanics });
  assert.equal(first.ready, true);
  assert.equal(ownership.activeGeneration, selected.plan.runtime.generation);
  assert.equal(ownership.stagedGeneration, null);
  assert.deepEqual(effects.filter((entry) => ['stage', 'definition', 'activate'].includes(entry)), ['stage', 'definition', 'activate']);
  const before = [...effects];
  const second = await reconcileLinuxLifecycleAuthorityRefresh({ candidateGeneration: selected.plan.runtime.generation, mechanics: composition.mechanics });
  assert.equal(second.ready, true);
  assert.deepEqual(effects.slice(before.length), ['probe']);
});

test('composition surfaces are closed and the neutral mechanic remains topology-free', async () => {
  const selected = values();
  const compositionRequest = Object.freeze({
    basePlan: selected.base,
    candidatePlan: selected.plan,
    candidate: selected.candidate,
    packageRoot: '/source/package',
    nodeExecutable: '/source/node',
    admitClaim: async () => true,
  });
  await assert.rejects(() => createLinuxLifecycleAuthorityRefreshComposition({
    ...compositionRequest,
    candidatePlan: Object.freeze({
      ...selected.plan,
      service: Object.freeze({ ...selected.plan.service, managementGroupId: 0 }),
    }),
  }), /required group identity is invalid/u);
  await assert.rejects(() => createLinuxLifecycleAuthorityRefreshComposition({
    ...compositionRequest,
    candidatePlan: Object.freeze({
      ...selected.plan,
      service: Object.freeze({ ...selected.plan.service, managementGroupId: selected.plan.service.managementGroupId + 1 }),
    }),
  }), /do not describe one installation/u);
  await assert.rejects(() => createLinuxLifecycleAuthorityRefreshComposition({
    ...compositionRequest,
    candidatePlan: Object.freeze({
      ...selected.plan,
      service: Object.freeze({ ...selected.plan.service, managementGroup: '../foreign' }),
    }),
  }), /required group identity is invalid/u);
  await assert.rejects(() => createLinuxLifecycleAuthorityRefreshComposition({ ...compositionRequest, groupIdentity: {} }), /unknown field/u);
  assert.throws(() => createLinuxLifecycleAuthorityGenerationSubjects({
    basePlan: selected.base,
    candidatePlan: selected.plan,
    candidate: selected.candidate,
    packageRoot: '/source/package',
    nodeExecutable: '/source/node',
    state: Object.freeze({ load() {}, save() {} }),
    foreign: true,
  }), /unknown field/u);
  assert.throws(() => createLinuxLifecycleAuthorityActivity({
    plan: selected.plan,
    state: Object.freeze({ load() {} }),
    subjects: Object.freeze({ resolve() {} }),
    foreign: true,
  }), /unknown field/u);
  await assert.rejects(() => probeLinuxLifecycleAuthority({ plan: selected.plan, foreign: true }), /unknown field/u);
  const mechanicSource = await readFile(new URL('../src/setup/linux-lifecycle-authority-refresh-mechanics.js', import.meta.url), 'utf8');
  assert.doesNotMatch(mechanicSource, /^import\s/mu);
  assert.doesNotMatch(mechanicSource, /systemd|systemctl|serviceName|unitPath|provider|repository|virtual machine|libvirt|qemu|socket|\/proc\//iu);
});
