import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INSTALL_LOCK_PROTOCOL,
  INSTALL_STATUS_PROTOCOL,
  INSTALLED_COMPONENT_FILES,
  installDevBridge,
  normalizeInstallRef,
  parseInstallArgs,
  resolveInstallSubject,
  verifyInstalledComponent,
} from '../install-devbridge.mjs';

const EXPECTED_COMPONENT_FILES = Object.freeze([
  'devbridge-entry.mjs',
  'src/entry/content-addressed-runner-provider.mjs',
  'src/entry/development-stable-subject-authority.mjs',
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

test('explicit branch install resolves once, installs the closed component, preserves Stage 0, and quarantines corruption', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-self-install-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const legacyLauncher = path.join(bin, 'devbridge.mjs');
  writeFileSync(legacyLauncher, 'legacy-stage0-sentinel\n');

  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  assert.equal(args.pinSelectedRunner, true);
  const installed = installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true });
  assert.equal(installed.componentHead, fixture.head);
  assert.equal(installed.pinnedRunnerHead, fixture.head);
  assert.equal(readFileSync(legacyLauncher, 'utf8'), 'legacy-stage0-sentinel\n');

  const component = path.join(home, 'entry', 'components', fixture.head);
  assert.equal(verifyInstalledComponent(component, fixture.head, fixture.source), true);
  assertInstalledClosure(component);

  const wrapperSource = readFileSync(installed.wrappers.javascript, 'utf8');
  assert.match(wrapperSource, new RegExp(fixture.head, 'u'));
  run(process.execPath, ['--check', installed.wrappers.javascript]);

  const installStatusResult = run(process.execPath, [installed.wrappers.javascript, 'entry-install-status']);
  const installStatus = JSON.parse(installStatusResult.stdout.trim());
  assert.equal(installStatus.protocol, INSTALL_STATUS_PROTOCOL);
  assert.equal(installStatus.componentHead, fixture.head);
  assert.equal(installStatus.pinnedRunnerHead, fixture.head);
  assert.equal(installStatus.home, installed.home);

  writeFileSync(path.join(component, 'devbridge-entry.mjs'), 'corrupt\n');
  assert.equal(verifyInstalledComponent(component, fixture.head, fixture.source), false);

  const degradedStatus = run(process.execPath, [installed.wrappers.javascript, 'entry-install-status']);
  assert.equal(JSON.parse(degradedStatus.stdout.trim()).componentHead, fixture.head);

  const repaired = installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true });
  assert.equal(repaired.componentHead, fixture.head);
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

test('unsafe manifest paths fail closed before they can become filesystem authority', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-manifest-path-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true });

  const component = path.join(home, 'entry', 'components', fixture.head);
  const manifestPath = path.join(component, '.devbridge-entry-install.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files[0].path = 'src/entry/..\\outside.mjs';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(verifyInstalledComponent(component, fixture.head, fixture.source), false);
});

test('wrapper activation preserves the prior authority before any replacement can become active', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-wrapper-transaction-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });

  const first = installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true });
  const firstWrapper = readFileSync(first.wrappers.javascript);
  const previous = path.join(home, 'bin', 'devbridge-entry.previous.mjs');

  const nextHead = fixture.advance();
  mkdirSync(previous);
  assert.throws(
    () => installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true }),
    /unsafe installer target/u,
  );
  assert.deepEqual(readFileSync(first.wrappers.javascript), firstWrapper);

  rmSync(previous, { recursive: true, force: true });
  const second = installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true });
  assert.equal(second.componentHead, nextHead);
  assert.notDeepEqual(readFileSync(second.wrappers.javascript), firstWrapper);
  assert.deepEqual(readFileSync(previous), firstWrapper);
});

test('installer lock fails closed for a live owner and reclaims only a dead owner record', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-install-lock-'));
  const fixture = fixtureRepository(root);
  const home = path.join(root, 'home');
  const entry = path.join(home, 'entry');
  mkdirSync(entry, { recursive: true });
  const lockPath = path.join(entry, '.install.lock');
  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });

  writeFileSync(lockPath, `${JSON.stringify({
    protocol: INSTALL_LOCK_PROTOCOL,
    pid: process.pid,
    startedAt: Date.now(),
    token: '11111111-1111-4111-8111-111111111111',
  })}\n`);
  assert.throws(
    () => installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true }),
    /installer is active/u,
  );

  rmSync(lockPath, { force: true });
  const deadPid = await exitedChildPid();
  writeFileSync(lockPath, `${JSON.stringify({
    protocol: INSTALL_LOCK_PROTOCOL,
    pid: deadPid,
    startedAt: Date.now(),
    token: '22222222-2222-4222-8222-222222222222',
  })}\n`);
  const installed = installDevBridge(args, { sourceRepository: fixture.source, allowLocalSource: true });
  assert.equal(installed.componentHead, fixture.head);
  assert.equal(readdirSync(entry).includes('.install.lock'), false);
});

test('default install leaves stable selection active while pinning is opt-in', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-installer-args-'));
  const args = parseInstallArgs(['--home', path.join(root, 'home')], { environment: {}, homeDirectory: root });
  assert.deepEqual(args.selector, { kind: 'branch', value: 'main' });
  assert.equal(args.pinSelectedRunner, false);
});
