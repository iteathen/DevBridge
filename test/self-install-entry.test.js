import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INSTALL_LOCK_PROTOCOL,
  INSTALL_STATUS_PROTOCOL,
  INSTALL_OWNERSHIP_REQUEST_PROTOCOL,
  INSTALLED_COMPONENT_FILES,
  installDevBridge,
  normalizeInstallRef,
  parseInstallArgs,
  resolveInstallSubject,
  observeInstallActivity,
  trackInstalledRunnerRef,
  verifyInstalledComponent,
} from '../install-devbridge.mjs';
import { createOwnershipState } from '../src/install/permanent-entry-installer/ownership-state.mjs';
import {
  createPermanentEntryInventory,
  ENTRY_PAYLOAD_INVENTORY_IDENTITY,
} from '../src/install/permanent-entry-inventory.js';
import { createApplicationRemovalSource } from '../src/app/application-removal.js';
import { createConditionalItemSet } from '../src/runtime/conditional-item-set.js';
import { createExactArtifactReceiptJournal } from '../src/runtime/exact-artifact-receipt.js';
import {
  createRunnerCacheInventory,
  RUNNER_CACHE_INVENTORY_IDENTITY,
} from '../src/entry/runner-cache-inventory.mjs';

const EXPECTED_COMPONENT_FILES = Object.freeze([
  'devbridge-entry.mjs',
  'src/entry/content-addressed-runner-provider.mjs',
  'src/entry/development-checkout-runner-provider.mjs',
  'src/entry/development-stable-subject-authority.mjs',
  'src/entry/exact-checkout-runner-provider.mjs',
  'src/entry/experimental-checkout-runner-provider.mjs',
  'src/entry/experimental-entry.mjs',
  'src/entry/experimental-subject-authority.mjs',
  'src/entry/github-runner-source.mjs',
  'src/entry/installation-identity.mjs',
  'src/entry/permanent-entry.mjs',
  'src/entry/production-stable-subject-authority.mjs',
  'src/entry/runner-cache-composition.mjs',
  'src/entry/runner-cache-ownership.mjs',
  'src/entry/stable-entry.mjs',
  'src/entry/stable-runner-state.mjs',
  'src/runtime/command-invocation.js',
  'src/runtime/conditional-item-set.js',
  'src/runtime/exact-artifact-receipt.js',
  'src/runtime/exact-artifact-set.js',
  'src/runtime/exact-directory.js',
  'src/runtime/exact-value-state.js',
  'src/runtime/local-filesystem-identity.js',
  'src/runtime/process-activity-lease.js',
  'src/runtime/providers/windows-filesystem-entry-observer.js',
  'src/runtime/receipt-item-collection.js',
]);

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    ...options,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout || result.error?.message));
  return result;
}

function git(args, cwd) {
  return run('git', args, { cwd }).stdout.trim();
}

function installDependencies(sourceRepository) {
  return {
    sourceRepository,
    allowLocalSource: true,
    attributeObserverFactory: () => ({ async isReparse() { return false; } }),
  };
}

function latestOwnershipRecord(home) {
  const directory = path.join(home, 'entry', 'ownership-receipts');
  const files = readdirSync(directory).sort();
  assert.ok(files.length > 0);
  return JSON.parse(readFileSync(path.join(directory, files.at(-1)), 'utf8'));
}

function ownershipByIdentity(home) {
  return new Map(latestOwnershipRecord(home).items.map((item) => [item.identity, item]));
}

function ownershipCollection(home) {
  const journal = createExactArtifactReceiptJournal({
    directory: path.join(home, 'entry', 'ownership-receipts'),
    scratch: path.join(home, 'entry', 'ownership-scratch'),
  });
  return createConditionalItemSet({ records: {
    async read() {
      const record = await journal.read();
      return record == null ? { revision: null, items: [] } : { revision: record.generation, items: record.items };
    },
    async compare({ revision, items }) {
      const outcome = await journal.compareAndAccept({ generation: revision, items });
      return {
        accepted: outcome.accepted,
        snapshot: outcome.record == null
          ? { revision: null, items: [] }
          : { revision: outcome.record.generation, items: outcome.record.items },
      };
    },
  } });
}

function fixtureRepository(root) {
  const source = path.join(root, 'source');
  mkdirSync(source, { recursive: true });
  for (const relative of EXPECTED_COMPONENT_FILES) {
    const target = path.join(source, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(new URL(`../${relative}`, import.meta.url), target);
  }
  git(['init', '-q'], source);
  git(['config', 'user.name', 'DevBridge Test'], source);
  git(['config', 'user.email', 'devbridge-test@example.invalid'], source);
  git(['add', '.'], source);
  git(['commit', '-q', '-m', 'entry fixture'], source);
  git(['branch', '-M', 'main'], source);
  return {
    source,
    head: git(['rev-parse', 'HEAD'], source),
    advance() {
      git(['commit', '--allow-empty', '-q', '-m', 'advance fixture'], source);
      return git(['rev-parse', 'HEAD'], source);
    },
  };
}

function assertInstalledClosure(component) {
  assert.deepEqual(INSTALLED_COMPONENT_FILES, EXPECTED_COMPONENT_FILES);
  const manifest = JSON.parse(readFileSync(path.join(component, '.devbridge-entry-install.json'), 'utf8'));
  assert.deepEqual(manifest.files.map((record) => record.path), EXPECTED_COMPONENT_FILES);

  for (const relative of ['src/entry/stable-entry.mjs', 'src/entry/experimental-entry.mjs']) {
    const url = pathToFileURL(path.join(component, ...relative.split('/'))).href;
    run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`]);
  }
}

function exitedChildPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    const pid = child.pid;
    child.once('error', reject);
    child.once('exit', () => {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        reject(new Error('child process did not expose a valid process identity'));
        return;
      }
      resolve(pid);
    });
  });
}

test('installer is actually standalone and accepts only bounded local selection', () => {
  assert.deepEqual(INSTALLED_COMPONENT_FILES, EXPECTED_COMPONENT_FILES);
  assert.deepEqual(normalizeInstallRef('cuda-target'), { kind: 'branch', value: 'cuda-target' });
  assert.throws(() => normalizeInstallRef('../other'), /invalid/u);
  assert.throws(() => normalizeInstallRef('other\\branch'), /invalid/u);

  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-installer-standalone-'));
  const isolated = path.join(root, 'downloaded-installer.mjs');
  copyFileSync(new URL('../install-devbridge.mjs', import.meta.url), isolated);
  run(process.execPath, ['--check', isolated], { cwd: root });
  const help = run(process.execPath, [isolated, '--help'], { cwd: root });
  assert.match(help.stdout, /permanent-entry installer/u);
});

test('installer Git acquisition ignores inherited Git authority and preserves only bounded transport environment', () => {
  const head = 'a'.repeat(40);
  let observed = null;
  const environment = {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? process.env.PATH ?? '',
    HOME: '/attacker/home',
    USERPROFILE: 'C:\\attacker',
    XDG_CONFIG_HOME: '/attacker/xdg',
    GIT_CONFIG_GLOBAL: '/attacker/global',
    GIT_CONFIG_SYSTEM: '/attacker/system',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.https://attacker.invalid/.insteadOf',
    GIT_CONFIG_VALUE_0: 'https://github.com/',
    GIT_SSH_COMMAND: 'attacker-command',
    HTTPS_PROXY: 'http://127.0.0.1:8080',
  };

  const subject = resolveInstallSubject('main', {
    environment,
    runner(executable, args, options) {
      observed = { executable, args, options };
      return { status: 0, stdout: `${head}\trefs/heads/main\n`, stderr: '' };
    },
  });

  assert.equal(subject.head, head);
  assert.equal(observed.executable, 'git');
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.env.HOME, undefined);
  assert.equal(observed.options.env.USERPROFILE, undefined);
  assert.equal(observed.options.env.XDG_CONFIG_HOME, undefined);
  assert.equal(observed.options.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(observed.options.env.GIT_SSH_COMMAND, undefined);
  assert.equal(observed.options.env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(observed.options.env.GIT_CONFIG_SYSTEM, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(observed.options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(observed.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(observed.options.env.HTTPS_PROXY, environment.HTTPS_PROXY);
  assert.deepEqual(observed.args.slice(0, 6), [
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
  ]);
});

test('explicit branch install resolves the component exactly while persisting the moving runner selector', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-self-install-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const legacyLauncher = path.join(bin, 'devbridge.mjs');
  writeFileSync(legacyLauncher, 'legacy-stage0-sentinel\n');

  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  assert.equal(args.selectedRunnerRef, 'main');
  assert.equal(Object.hasOwn(args, 'pinSelectedRunner'), false);
  const installed = await installDevBridge(args, installDependencies(fixture.source));
  assert.equal(installed.componentHead, fixture.head);
  assert.equal(installed.selectedRunnerRef, 'main');
  assert.equal(installed.pinnedRunnerHead, null);
  assert.equal(readFileSync(legacyLauncher, 'utf8'), 'legacy-stage0-sentinel\n');

  const component = path.join(home, 'entry', 'components', fixture.head);
  assert.equal(verifyInstalledComponent(component, fixture.head, fixture.source), true);
  assertInstalledClosure(component);

  const wrapperSource = readFileSync(installed.wrappers.javascript, 'utf8');
  assert.match(wrapperSource, /const selected = "main"/u);
  assert.match(wrapperSource, /--entry-development-ref/u);
  run(process.execPath, ['--check', installed.wrappers.javascript]);

  const installStatusResult = run(process.execPath, [installed.wrappers.javascript, 'entry-install-status']);
  const installStatus = JSON.parse(installStatusResult.stdout.trim());
  assert.equal(installStatus.protocol, INSTALL_STATUS_PROTOCOL);
  assert.equal(installStatus.componentHead, fixture.head);
  assert.equal(installStatus.selectedRunnerRef, 'main');
  assert.equal(installStatus.pinnedRunnerHead, null);
  assert.equal(installStatus.home, installed.home);

  writeFileSync(path.join(component, 'devbridge-entry.mjs'), 'corrupt\n');
  assert.equal(verifyInstalledComponent(component, fixture.head, fixture.source), false);

  const degradedStatus = run(process.execPath, [installed.wrappers.javascript, 'entry-install-status']);
  assert.equal(JSON.parse(degradedStatus.stdout.trim()).componentHead, fixture.head);

  const repaired = await installDevBridge(args, installDependencies(fixture.source));
  assert.equal(repaired.componentHead, fixture.head);
  assert.equal(repaired.selectedRunnerRef, 'main');
  assert.equal(verifyInstalledComponent(component, fixture.head, fixture.source), true);
  assert.equal(readFileSync(legacyLauncher, 'utf8'), 'legacy-stage0-sentinel\n');

  const quarantine = path.join(home, 'entry', 'quarantine');
  const retained = readdirSync(quarantine);
  assert.equal(retained.length, 1);
  assert.equal(
    readFileSync(path.join(quarantine, retained[0], 'devbridge-entry.mjs'), 'utf8'),
    'corrupt\n',
  );
});

test('explicit exact install remains exact-pinned and track migration accepts branches only', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-exact-install-'));
  const fixture = fixtureRepository(root);
  const exactHome = path.join(root, 'exact-home');
  const exactArgs = parseInstallArgs(['--ref', fixture.head, '--home', exactHome], { environment: {}, homeDirectory: root });
  assert.equal(exactArgs.selectedRunnerRef, fixture.head);
  assert.equal(Object.hasOwn(exactArgs, 'pinSelectedRunner'), false);
  const exact = await installDevBridge(exactArgs, installDependencies(fixture.source));
  assert.equal(exact.selectedRunnerRef, fixture.head);
  assert.equal(exact.pinnedRunnerHead, fixture.head);
  const status = JSON.parse(run(process.execPath, [exact.wrappers.javascript, 'entry-install-status']).stdout.trim());
  assert.equal(status.selectedRunnerRef, fixture.head);
  assert.equal(status.pinnedRunnerHead, fixture.head);

  const trackedHome = path.join(root, 'tracked-home');
  const tracked = await trackInstalledRunnerRef({ home: trackedHome, ref: 'main' }, installDependencies(fixture.source));
  assert.equal(tracked.componentHead, fixture.head);
  assert.equal(tracked.selectedRunnerRef, 'main');
  assert.equal(tracked.pinnedRunnerHead, null);
  await assert.rejects(
    () => trackInstalledRunnerRef({ home: path.join(root, 'rejected-home'), ref: fixture.head }, installDependencies(fixture.source)),
    /must be a branch selector/u,
  );
});

test('unsafe manifest paths fail closed before they can become filesystem authority', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-manifest-path-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  await installDevBridge(args, installDependencies(fixture.source));

  const component = path.join(home, 'entry', 'components', fixture.head);
  const manifestPath = path.join(component, '.devbridge-entry-install.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files[0].path = 'src/entry/..\\outside.mjs';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(verifyInstalledComponent(component, fixture.head, fixture.source), false);
});

test('wrapper activation preserves the prior authority before any replacement can become active', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-wrapper-transaction-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });

  const first = await installDevBridge(args, installDependencies(fixture.source));
  const firstWrapper = readFileSync(first.wrappers.javascript);
  const previous = path.join(home, 'bin', 'devbridge-entry.previous.mjs');

  const nextHead = fixture.advance();
  mkdirSync(previous);
  await assert.rejects(
    () => installDevBridge(args, installDependencies(fixture.source)),
    /unsafe entry state/u,
  );
  assert.deepEqual(readFileSync(first.wrappers.javascript), firstWrapper);

  rmSync(previous, { recursive: true, force: true });
  const second = await installDevBridge(args, installDependencies(fixture.source));
  assert.equal(second.componentHead, nextHead);
  assert.equal(second.selectedRunnerRef, 'main');
  assert.notDeepEqual(readFileSync(second.wrappers.javascript), firstWrapper);
  assert.deepEqual(readFileSync(previous), firstWrapper);
});

test('installer lock fails closed for a live owner and reclaims only a dead owner record', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-install-lock-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const entry = path.join(home, 'entry');
  mkdirSync(entry, { recursive: true });
  const lockPath = path.join(home, '.install.lock');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });

  writeFileSync(lockPath, `${JSON.stringify({
    protocol: INSTALL_LOCK_PROTOCOL,
    pid: process.pid,
    startedAt: Date.now(),
    token: '11111111-1111-4111-8111-111111111111',
  })}\n`);
  await assert.rejects(
    () => installDevBridge(args, installDependencies(fixture.source)),
    /installation mutation is active/u,
  );

  rmSync(lockPath, { force: true });
  const deadPid = await exitedChildPid();
  writeFileSync(lockPath, `${JSON.stringify({
    protocol: INSTALL_LOCK_PROTOCOL,
    pid: deadPid,
    startedAt: Date.now(),
    token: '22222222-2222-4222-8222-222222222222',
  })}\n`);
  const installed = await installDevBridge(args, installDependencies(fixture.source));
  assert.equal(installed.componentHead, fixture.head);
  assert.equal(readdirSync(home).includes('.install.lock'), false);
});

test('production ownership receipts are exact, idempotent, and retain older component generations', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-install-ownership-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });

  await installDevBridge(args, installDependencies(fixture.source));
  const first = latestOwnershipRecord(home);
  const firstItems = new Map(first.items.map((item) => [item.identity, item]));
  assert.equal(firstItems.get('control').value.phase, 'control');
  for (const identity of [`component.${fixture.head}`, 'entry.primary', 'entry.command', 'entry.shell']) {
    assert.equal(firstItems.get(identity).provenance, 'created');
    assert.equal(firstItems.get(identity).value.phase, 'complete');
  }
  assert.equal(firstItems.has('entry.previous'), false);
  const revisions = readdirSync(path.join(home, 'entry', 'ownership-receipts')).length;

  await installDevBridge(args, installDependencies(fixture.source));
  assert.equal(latestOwnershipRecord(home).generation, first.generation);
  assert.equal(readdirSync(path.join(home, 'entry', 'ownership-receipts')).length, revisions);

  const nextHead = fixture.advance();
  await installDevBridge(args, installDependencies(fixture.source));
  const advanced = ownershipByIdentity(home);
  assert.equal(advanced.get(`component.${fixture.head}`).value.phase, 'complete');
  assert.equal(advanced.get(`component.${nextHead}`).provenance, 'created');
  assert.equal(advanced.get('entry.previous').provenance, 'created');
  assert.equal(advanced.get('entry.primary').provenance, 'created');
  assert.deepEqual(readdirSync(path.join(home, 'entry', 'staging')), []);
  assert.deepEqual(readdirSync(path.join(home, 'entry', 'ownership-scratch')), []);
  assert.equal(readdirSync(path.join(home, 'bin')).some((name) => name.includes('.next')), false);
  assert.equal([...advanced.keys()].some((identity) => identity.includes('quarantine')), false);
});

test('production ownership receipts project a private read-only payload inventory without completing the application', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-install-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  await installDevBridge(args, installDependencies(fixture.source));

  const inventory = createPermanentEntryInventory({ home }, {
    attributeObserverFactory: () => ({ async isReparse() { return false; } }),
  });
  const fragment = await inventory.snapshot();
  const wrappers = ['entry.command', 'entry.primary', 'entry.shell'];
  assert.equal(inventory.identity, ENTRY_PAYLOAD_INVENTORY_IDENTITY);
  assert.deepEqual(fragment.coverage, ['application']);
  assert.equal(fragment.mutationActive, false);
  assert.deepEqual(fragment.items.map((item) => item.identity), [`component.${fixture.head}`, ...wrappers]);
  assert.deepEqual(fragment.items[0].after, wrappers);
  assert.equal(fragment.items.every((item) => item.scope === 'payload' && item.effects.length === 1), true);
  assert.doesNotMatch(JSON.stringify(fragment), /[A-Z]:\\|ownership-receipts|\.devbridge-entry-install/u);
  assert.equal(existsSync(path.join(home, 'entry', 'ownership-bindings.json')), false);

  const cacheInventory = createRunnerCacheInventory({ home });
  assert.deepEqual((await cacheInventory.snapshot()).coverage, ['application']);

  const source = createApplicationRemovalSource({
    contributors: [
      {
        identity: inventory.identity,
        snapshot: () => inventory.snapshot(),
        run: (_mode, operation) => inventory.run(operation),
      },
      {
        identity: cacheInventory.identity,
        snapshot: () => cacheInventory.snapshot(),
        run: (_mode, operation) => cacheInventory.run(operation),
      },
    ],
    required: {
      application: [ENTRY_PAYLOAD_INVENTORY_IDENTITY, RUNNER_CACHE_INVENTORY_IDENTITY, 'runtime-payload'],
      purge: ['authority-state'],
    },
  });
  assert.deepEqual((await source.snapshot()).coverage, []);
});

test('an exact pre-receipt installation is adopted while foreign entry state is preserved', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-install-adoption-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  await installDevBridge(args, installDependencies(fixture.source));
  rmSync(path.join(home, 'entry', 'ownership-receipts'), { recursive: true, force: true });

  await installDevBridge(args, installDependencies(fixture.source));
  const adopted = ownershipByIdentity(home);
  for (const identity of [`component.${fixture.head}`, 'entry.primary', 'entry.command', 'entry.shell']) {
    assert.equal(adopted.get(identity).provenance, 'adopted');
    assert.equal(adopted.get(identity).value.phase, 'complete');
  }

  const foreignHome = path.join(root, 'foreign-home');
  const foreignBin = path.join(foreignHome, 'bin');
  mkdirSync(foreignBin, { recursive: true });
  const foreign = path.join(foreignBin, 'devbridge-entry.mjs');
  writeFileSync(foreign, 'foreign-entry-sentinel\n');
  const foreignArgs = parseInstallArgs(['--ref', 'main', '--home', foreignHome], { environment: {}, homeDirectory: root });
  await assert.rejects(() => installDevBridge(foreignArgs, installDependencies(fixture.source)), /unrecognized entry state/u);
  assert.equal(readFileSync(foreign, 'utf8'), 'foreign-entry-sentinel\n');
  assert.equal(ownershipByIdentity(foreignHome).has('entry.primary'), false);

  const linkedHome = path.join(root, 'linked-home');
  const linkedBin = path.join(linkedHome, 'bin');
  mkdirSync(linkedBin, { recursive: true });
  const linkedSource = path.join(linkedBin, 'foreign-source');
  const linkedEntry = path.join(linkedBin, 'devbridge-entry.mjs');
  writeFileSync(linkedSource, 'multiply-linked-entry-sentinel\n');
  linkSync(linkedSource, linkedEntry);
  const linkedArgs = parseInstallArgs(['--ref', 'main', '--home', linkedHome], { environment: {}, homeDirectory: root });
  await assert.rejects(() => installDevBridge(linkedArgs, installDependencies(fixture.source)), /unsafe entry state/u);
  assert.equal(readFileSync(linkedSource, 'utf8'), 'multiply-linked-entry-sentinel\n');
  assert.equal(readFileSync(linkedEntry, 'utf8'), 'multiply-linked-entry-sentinel\n');
  assert.equal(ownershipByIdentity(linkedHome).has('entry.primary'), false);
});

test('an exact completed publication reconciles its durable pending reservation after restart', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-install-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  const installed = await installDevBridge(args, installDependencies(fixture.source));
  const target = installed.wrappers.javascript;
  const bytes = readFileSync(target);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const state = createOwnershipState({ collection: ownershipCollection(home) });
  const pending = await state.reserve({
    identity: 'entry.primary',
    provenance: 'created',
    request: {
      protocol: INSTALL_OWNERSHIP_REQUEST_PROTOCOL,
      kind: 'file',
      role: 'primary',
      target,
      stage: path.join(path.dirname(target), '.entry-primary-recovery.next'),
      bytes: statSync(target).size,
      sha256: digest,
      beforeDigest: digest,
    },
  });
  assert.equal(pending.value.phase, 'reserved');

  await installDevBridge(args, installDependencies(fixture.source));
  const recovered = ownershipByIdentity(home).get('entry.primary');
  assert.equal(recovered.value.phase, 'complete');
  assert.equal(recovered.value.operation, pending.value.operation);
  assert.equal(existsSync(pending.value.request.stage), false);
});

test('installation activity is observable while receipt publication is pending and inactive afterward', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-install-activity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  let enter;
  let resume;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  let paused = false;
  const receiptJournalFactory = (options) => {
    const journal = createExactArtifactReceiptJournal(options);
    return {
      read: () => journal.read(),
      async compareAndAccept(request) {
        if (!paused) {
          paused = true;
          enter();
          await gate;
        }
        return journal.compareAndAccept(request);
      },
    };
  };
  const installing = installDevBridge(args, { ...installDependencies(fixture.source), receiptJournalFactory });
  await entered;
  assert.deepEqual(observeInstallActivity({ home }), { active: true });
  const inventory = createPermanentEntryInventory({ home }, {
    receiptJournalFactory,
    attributeObserverFactory: () => ({ async isReparse() { return false; } }),
  });
  const fragment = await inventory.snapshot();
  assert.equal(fragment.mutationActive, true);
  assert.deepEqual(fragment.coverage, []);
  resume();
  await installing;
  assert.deepEqual(observeInstallActivity({ home }), { active: false });
});

test('default install leaves stable selection active while explicit exact pinning remains opt-in', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-installer-args-'));
  const args = parseInstallArgs(['--home', path.join(root, 'home')], { environment: {}, homeDirectory: root });
  assert.deepEqual(args.selector, { kind: 'branch', value: 'main' });
  assert.equal(args.selectedRunnerRef, null);
  assert.equal(Object.hasOwn(args, 'pinSelectedRunner'), false);
});

const HISTORICAL_ENTRY_COMPONENT_FILES = Object.freeze([
  'devbridge-entry.mjs',
  'src/entry/content-addressed-runner-provider.mjs',
  'src/entry/development-checkout-runner-provider.mjs',
  'src/entry/development-stable-subject-authority.mjs',
  'src/entry/exact-checkout-runner-provider.mjs',
  'src/entry/experimental-checkout-runner-provider.mjs',
  'src/entry/experimental-entry.mjs',
  'src/entry/experimental-subject-authority.mjs',
  'src/entry/github-runner-source.mjs',
  'src/entry/installation-identity.mjs',
  'src/entry/permanent-entry.mjs',
  'src/entry/production-stable-subject-authority.mjs',
  'src/entry/stable-entry.mjs',
  'src/entry/stable-runner-state.mjs',
]);

function rewriteComponentMembership(component, files) {
  const selected = new Set(files);
  const manifestPath = path.join(component, '.devbridge-entry-install.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const item of manifest.files) {
    if (!selected.has(item.path)) rmSync(path.join(component, ...item.path.split('/')), { force: true });
  }
  manifest.files = manifest.files.filter((item) => selected.has(item.path));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + String.fromCharCode(10));
}

function clearInstallerOwnershipReceipts(home) {
  rmSync(path.join(home, 'entry', 'ownership-receipts'), { recursive: true, force: true });
  rmSync(path.join(home, 'entry', 'ownership-scratch'), { recursive: true, force: true });
}

test('historical permanent-entry membership upgrades through exact closed compatibility', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-historical-entry-upgrade-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  const initial = await installDevBridge(args, installDependencies(fixture.source));
  const historicalHead = initial.componentHead;
  const historicalComponent = path.join(home, 'entry', 'components', historicalHead);

  rewriteComponentMembership(historicalComponent, HISTORICAL_ENTRY_COMPONENT_FILES);
  assert.equal(verifyInstalledComponent(historicalComponent, historicalHead, fixture.source), false);
  clearInstallerOwnershipReceipts(home);

  const nextHead = fixture.advance();
  const upgraded = await installDevBridge(args, installDependencies(fixture.source));
  assert.equal(upgraded.componentHead, nextHead);
  assert.equal(existsSync(historicalComponent), true);

  const previous = path.join(home, 'bin', 'devbridge-entry.previous.mjs');
  const previousStatus = JSON.parse(run(process.execPath, [previous, 'entry-install-status']).stdout.trim());
  assert.equal(previousStatus.componentHead, historicalHead);
  const currentStatus = JSON.parse(run(process.execPath, [upgraded.wrappers.javascript, 'entry-install-status']).stdout.trim());
  assert.equal(currentStatus.componentHead, nextHead);
});

test('historical reference compatibility rejects unknown component membership', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-historical-entry-reject-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  const initial = await installDevBridge(args, installDependencies(fixture.source));
  const historicalHead = initial.componentHead;
  const historicalComponent = path.join(home, 'entry', 'components', historicalHead);
  const unknownMembership = [
    ...HISTORICAL_ENTRY_COMPONENT_FILES,
    'src/entry/runner-cache-composition.mjs',
  ];

  rewriteComponentMembership(historicalComponent, unknownMembership);
  clearInstallerOwnershipReceipts(home);
  fixture.advance();

  await assert.rejects(
    () => installDevBridge(args, installDependencies(fixture.source)),
    /Recognized primary file does not reference an accepted subject/u,
  );
  const primary = path.join(home, 'bin', 'devbridge-entry.mjs');
  const status = JSON.parse(run(process.execPath, [primary, 'entry-install-status']).stdout.trim());
  assert.equal(status.componentHead, historicalHead);
});
