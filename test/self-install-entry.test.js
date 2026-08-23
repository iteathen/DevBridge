import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INSTALL_STATUS_PROTOCOL,
  installDevBridge,
  normalizeInstallRef,
  parseInstallArgs,
  verifyInstalledComponent,
} from '../install-devbridge.mjs';

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
  mkdirSync(path.join(source, 'src'), { recursive: true });
  copyFileSync(new URL('../devbridge-entry.mjs', import.meta.url), path.join(source, 'devbridge-entry.mjs'));
  cpSync(new URL('../src/entry', import.meta.url), path.join(source, 'src', 'entry'), { recursive: true });
  git(['init', '-q'], source);
  git(['config', 'user.name', 'DevBridge Test'], source);
  git(['config', 'user.email', 'devbridge-test@example.invalid'], source);
  git(['add', '.'], source);
  git(['commit', '-q', '-m', 'entry fixture'], source);
  git(['branch', '-M', 'main'], source);
  return { source, head: git(['rev-parse', 'HEAD'], source) };
}

test('installer remains standalone and accepts only bounded local selection', () => {
  const source = readFileSync(new URL('../install-devbridge.mjs', import.meta.url), 'utf8');
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/gu)) assert.match(match[1], /^node:/u);
  assert.deepEqual(normalizeInstallRef('cuda-target'), { kind: 'branch', value: 'cuda-target' });
  assert.throws(() => normalizeInstallRef('../other'), /invalid/u);
  assert.throws(() => normalizeInstallRef('other\\branch'), /invalid/u);

  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-installer-standalone-'));
  const isolated = path.join(root, 'downloaded-installer.mjs');
  copyFileSync(new URL('../install-devbridge.mjs', import.meta.url), isolated);
  const help = run(process.execPath, [isolated, '--help'], { cwd: root });
  assert.match(help.stdout, /permanent-entry installer/u);
});

test('explicit branch install resolves once, pins exact runner, preserves Stage 0, and repairs component corruption', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-self-install-'));
  const { source, head } = fixtureRepository(root);
  const home = path.join(root, 'home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const legacyLauncher = path.join(bin, 'devbridge.mjs');
  writeFileSync(legacyLauncher, 'legacy-stage0-sentinel\n');

  const args = parseInstallArgs(['--ref', 'main', '--home', home], { environment: {}, homeDirectory: root });
  assert.equal(args.pinSelectedRunner, true);
  const installed = installDevBridge(args, { sourceRepository: source, allowLocalSource: true });
  assert.equal(installed.componentHead, head);
  assert.equal(installed.pinnedRunnerHead, head);
  assert.equal(readFileSync(legacyLauncher, 'utf8'), 'legacy-stage0-sentinel\n');

  const component = path.join(home, 'entry', 'components', head);
  assert.equal(verifyInstalledComponent(component, head, source), true);
  const wrapperSource = readFileSync(installed.wrappers.javascript, 'utf8');
  assert.match(wrapperSource, new RegExp(head, 'u'));
  run(process.execPath, ['--check', installed.wrappers.javascript]);

  const statusResult = run(process.execPath, [installed.wrappers.javascript, 'entry-install-status']);
  const status = JSON.parse(statusResult.stdout.trim());
  assert.equal(status.protocol, INSTALL_STATUS_PROTOCOL);
  assert.equal(status.componentHead, head);
  assert.equal(status.pinnedRunnerHead, head);
  assert.equal(path.resolve(status.home), path.resolve(home));

  writeFileSync(path.join(component, 'devbridge-entry.mjs'), 'corrupt\n');
  assert.equal(verifyInstalledComponent(component, head, source), false);
  const repaired = installDevBridge(args, { sourceRepository: source, allowLocalSource: true });
  assert.equal(repaired.componentHead, head);
  assert.equal(verifyInstalledComponent(component, head, source), true);
  assert.equal(readFileSync(legacyLauncher, 'utf8'), 'legacy-stage0-sentinel\n');
});

test('default install leaves stable selection active while pinning is opt-in', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-installer-args-'));
  const args = parseInstallArgs(['--home', path.join(root, 'home')], { environment: {}, homeDirectory: root });
  assert.deepEqual(args.selector, { kind: 'branch', value: 'main' });
  assert.equal(args.pinSelectedRunner, false);
});
