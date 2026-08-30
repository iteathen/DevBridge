import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  installDevBridge,
  parseInstallArgs,
  verifyInstalledComponent,
} from '../install-devbridge.mjs';
import {
  APPLICATION_REMOVAL_PROTOCOL,
  createApplicationRemoval,
  createApplicationRemovalSource,
} from '../src/app/application-removal.js';
import { createBoundEffectActions } from '../src/runtime/bound-effect-actions.js';
import { createExactArtifactInventory } from '../src/runtime/exact-artifact-inventory.js';
import { createExactArtifactSet } from '../src/runtime/exact-artifact-set.js';
import { createRevisionedRecordStateStore } from '../src/state/revisioned-record-state-store.js';

const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function artifactActions() {
  return createExactArtifactSet({
    platform: process.platform,
    ...(process.platform === 'win32' ? { inspectReparse: async (_location, info) => info.isSymbolicLink() } : {}),
  });
}

function activity(active = false) {
  return { async observe({ identity }) { return { identity, active }; } };
}

function contributor(value) {
  return { identity: value.identity, snapshot: value.snapshot };
}

function completeSource(value) {
  return createApplicationRemovalSource({
    contributors: [contributor(value)],
    required: { application: [value.identity], purge: [value.identity] },
  });
}

function application({ inventory, artifacts, journalFile }) {
  return createApplicationRemoval({
    source: completeSource(inventory),
    journal: createRevisionedRecordStateStore(journalFile),
    effects: createBoundEffectActions({ catalog: inventory, actions: artifacts }),
  });
}

async function exists(location) {
  try { await lstat(location); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('a verified installed payload is bound before exact removal and remains restart-reconcilable', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-inventory-installed-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, 'home');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', shell: false, windowsHide: true }).trim();
  const args = parseInstallArgs(['--install-only', '--ref', head, '--home', home], { environment: {}, homeDirectory: parent });
  installDevBridge(args, { sourceRepository: repository, allowLocalSource: true });
  const root = path.join(home, 'entry', 'components', head);
  assert.equal(verifyInstalledComponent(root, head, repository), true);

  const artifacts = artifactActions();
  const bindingFile = path.join(parent, 'state', 'bindings.json');
  const journalFile = path.join(parent, 'state', 'journal.json');
  const source = {
    async observe({ identity }) {
      if (!(await exists(root))) return { identity, generation: `subject-${head}`, state: 'absent' };
      return {
        identity,
        generation: `subject-${head}`,
        state: verifyInstalledComponent(root, head, repository) ? 'created' : 'foreign',
      };
    },
  };
  const makeInventory = () => createExactArtifactInventory({
    identity: 'payload-one',
    location: root,
    scope: 'payload',
    coverage: ['application', 'purge'],
    source,
    activity: activity(),
    records: createRevisionedRecordStateStore(bindingFile),
    actions: artifacts,
  });

  const inventory = makeInventory();
  const api = application({ inventory, artifacts, journalFile });
  const plan = await api.inspect({ mode: 'application' });
  assert.equal(plan.complete, true);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.selected.map((entry) => entry.identity), ['payload-one']);
  assert.equal(JSON.stringify(plan).includes(root), false);

  const result = await api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.deepEqual(result.removed, ['payload-one']);
  assert.equal(await exists(root), false);

  const restarted = makeInventory();
  const after = await completeSource(restarted).snapshot();
  const before = await completeSource(inventory).snapshot();
  assert.equal(after.generation, before.generation);
  assert.deepEqual(after.items, before.items);
  const repeated = await application({ inventory: restarted, artifacts, journalFile }).remove({
    mode: 'application',
    planDigest: plan.digest,
    confirmation: 'REMOVE',
  });
  assert.equal(repeated.complete, true);
  assert.deepEqual(repeated.removed, ['payload-one']);

  const durable = await readFile(bindingFile, 'utf8');
  assert.match(durable, /devbridge\/exact-artifact-inventory-v1/u);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('a bound descriptor detects later content substitution without widening the target', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-inventory-drift-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'payload');
  await mkdir(root);
  await writeFile(path.join(root, 'value.txt'), 'first');
  const artifacts = artifactActions();
  const inventory = createExactArtifactInventory({
    identity: 'payload-drift',
    location: root,
    scope: 'payload',
    coverage: ['application', 'purge'],
    source: { async observe({ identity }) { return { identity, generation: 'source-one', state: 'created' }; } },
    activity: activity(),
    records: createRevisionedRecordStateStore(path.join(parent, 'bindings.json')),
    actions: artifacts,
  });
  const fragment = await inventory.snapshot();
  const plan = await createApplicationRemoval({
    source: completeSource(inventory),
    journal: createRevisionedRecordStateStore(path.join(parent, 'journal.json')),
    effects: createBoundEffectActions({ catalog: inventory, actions: artifacts }),
  }).inspect({ mode: 'application' });
  const effect = fragment.items[0].effects[0];
  const input = {
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    mode: 'application',
    item: 'payload-drift',
    planDigest: plan.digest,
    effect,
  };
  const bridge = createBoundEffectActions({ catalog: inventory, actions: artifacts });
  await bridge.bind(input);
  await writeFile(path.join(root, 'value.txt'), 'other');
  assert.deepEqual(await bridge.observe(input), { identity: effect.identity, state: 'ambiguous', retryable: false });
  await assert.rejects(() => bridge.remove(input), /ambiguous/u);
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'other');
});

test('source or activity drift before durable binding creates no action authority', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-inventory-binding-drift-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'payload');
  await mkdir(root);
  await writeFile(path.join(root, 'value.txt'), 'first');
  const artifacts = artifactActions();
  let state = 'created';
  const records = createRevisionedRecordStateStore(path.join(parent, 'bindings.json'));
  const inventory = createExactArtifactInventory({
    identity: 'payload-binding-drift',
    location: root,
    scope: 'payload',
    coverage: ['application', 'purge'],
    source: { async observe({ identity }) { return { identity, generation: 'source-one', state }; } },
    activity: activity(),
    records,
    actions: artifacts,
  });
  const fragment = await inventory.snapshot();
  const plan = await createApplicationRemoval({
    source: completeSource(inventory),
    journal: createRevisionedRecordStateStore(path.join(parent, 'journal.json')),
    effects: createBoundEffectActions({ catalog: inventory, actions: artifacts }),
  }).inspect({ mode: 'application' });
  state = 'foreign';
  await assert.rejects(() => inventory.bind({
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    mode: 'application',
    item: inventory.identity,
    planDigest: plan.digest,
    effect: fragment.items[0].effects[0],
  }), /changed before acceptance/u);
  const stored = await records.run(inventory.identity, (session) => session.load());
  assert.equal(stored, undefined);
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'first');
});

test('foreign state is preserved and active mutation blocks discovery and removal readiness', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-inventory-policy-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'payload');
  await mkdir(root);
  await writeFile(path.join(root, 'value.txt'), 'foreign');
  const artifacts = artifactActions();
  const foreign = createExactArtifactInventory({
    identity: 'payload-foreign',
    location: root,
    scope: 'payload',
    coverage: ['application', 'purge'],
    source: { async observe({ identity }) { return { identity, generation: 'source-foreign', state: 'foreign' }; } },
    activity: activity(),
    records: createRevisionedRecordStateStore(path.join(parent, 'foreign.json')),
    actions: artifacts,
  });
  const foreignPlan = await createApplicationRemoval({
    source: completeSource(foreign),
    journal: createRevisionedRecordStateStore(path.join(parent, 'foreign-journal.json')),
    effects: createBoundEffectActions({ catalog: foreign, actions: artifacts }),
  }).inspect({ mode: 'application' });
  assert.deepEqual(foreignPlan.selected, []);
  assert.deepEqual(foreignPlan.preserved[0].reasons, ['foreign']);

  let sourceObserved = false;
  let discovered = false;
  const active = createExactArtifactInventory({
    identity: 'payload-active',
    location: root,
    scope: 'payload',
    coverage: ['application', 'purge'],
    source: { async observe({ identity }) { sourceObserved = true; return { identity, generation: 'source-active', state: 'created' }; } },
    activity: activity(true),
    records: createRevisionedRecordStateStore(path.join(parent, 'active.json')),
    actions: {
      async discover(request) { discovered = true; return artifacts.discover(request); },
      async observe(request) { return artifacts.observe(request); },
    },
  });
  const activePlan = await createApplicationRemoval({
    source: completeSource(active),
    journal: createRevisionedRecordStateStore(path.join(parent, 'active-journal.json')),
    effects: createBoundEffectActions({ catalog: active, actions: artifacts }),
  }).inspect({ mode: 'application' });
  assert.equal(activePlan.complete, true);
  assert.equal(activePlan.ready, false);
  assert.equal(sourceObserved, false);
  assert.equal(discovered, false);
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'foreign');
});
