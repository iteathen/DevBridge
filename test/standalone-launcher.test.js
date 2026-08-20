import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.stdout || result.error?.message));
}

function initializeRuntimeRepository(runtime) {
  git(['init'], runtime);
  git(['config', 'user.email', 'devbridge-test@example.invalid'], runtime);
  git(['config', 'user.name', 'DevBridge Test'], runtime);
  git(['remote', 'add', 'origin', 'https://github.com/iteathen/DevBridge.git'], runtime);
  git(['add', '.'], runtime);
  git(['commit', '-m', 'fixture'], runtime);
}

test('standalone launcher reaches managed bootstrap with no adjacent src tree', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-stage0-'));
  const downloadDir = path.join(root, 'download');
  const home = path.join(root, 'home');
  const runtime = path.join(home, 'runtime');
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(path.join(runtime, 'src', 'bootstrap'), { recursive: true });
  const launcher = path.join(downloadDir, 'devbridge.mjs');
  copyFileSync(new URL('../devbridge.mjs', import.meta.url), launcher);
  writeFileSync(path.join(runtime, 'package.json'), '{"name":"devbridge","version":"0.1.0","type":"module","devbridge":{"stage0Protocol":1}}\n');
  writeFileSync(path.join(runtime, 'src', 'bootstrap', 'secure-bootstrap.mjs'), `import { writeFileSync } from 'node:fs'; export async function bootstrap(argv) { writeFileSync(new URL('../../../stage0-marker.json', import.meta.url), JSON.stringify(argv)); return 0; }`);
  initializeRuntimeRepository(runtime);
  const result = spawnSync(process.execPath, [launcher, 'doctor', '--home', home, '--no-update'], { cwd: downloadDir, encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  assert.equal(path.join(downloadDir, 'src') === path.join(runtime, 'src'), false);
  const args = JSON.parse(readFileSync(path.join(home, 'stage0-marker.json'), 'utf8'));
  assert.deepEqual(args, ['doctor', '--home', home, '--no-update']);
});

test('standalone launcher help is available before installation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-stage0-help-'));
  const launcher = path.join(root, 'devbridge.mjs');
  const home = path.join(root, 'uncreated-home');
  copyFileSync(new URL('../devbridge.mjs', import.meta.url), launcher);
  const result = spawnSync(process.execPath, [launcher, '--help', '--home', home], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  assert.match(result.stdout, /install[\s\S]+doctor[\s\S]+update[\s\S]+status/u);
  assert.equal(existsSync(home), false);
});

test('explicit setup reoffers the persisted channel while normal commands reuse it directly', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-stage0-channel-'));
  const home = path.join(root, 'home');
  const runtime = path.join(home, 'runtime');
  mkdirSync(path.join(runtime, 'src', 'bootstrap'), { recursive: true });
  const launcher = path.join(root, 'devbridge.mjs');
  copyFileSync(new URL('../devbridge.mjs', import.meta.url), launcher);
  writeFileSync(path.join(home, 'bootstrap-policy.json'), `${JSON.stringify({ protocol: 'devbridge/bootstrap-policy-v1', channel: 'stable' })}\n`);
  writeFileSync(path.join(runtime, 'package.json'), '{"name":"devbridge","version":"0.1.0","type":"module","devbridge":{"stage0Protocol":1}}\n');
  writeFileSync(path.join(runtime, 'src', 'bootstrap', 'secure-bootstrap.mjs'), `import { writeFileSync } from 'node:fs'; export async function bootstrap(argv) { writeFileSync(new URL('../../../stage0-marker.json', import.meta.url), JSON.stringify(argv)); return 0; }`);
  initializeRuntimeRepository(runtime);
  const result = spawnSync(process.execPath, [launcher, 'setup', '--home', home, '--no-update'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'stage0-marker.json'), 'utf8')), [
    'setup', '--home', home, '--no-update', '--channel', 'stable', '--prompt-channel',
  ]);
});

test('standalone launcher accepts the real DevBridge managed bootstrap stack', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-stage0-real-'));
  const downloadDir = path.join(root, 'download');
  const home = path.join(root, 'home');
  const runtime = path.join(home, 'runtime');
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(runtime, { recursive: true });

  const launcher = path.join(downloadDir, 'devbridge.mjs');
  copyFileSync(new URL('../devbridge.mjs', import.meta.url), launcher);
  copyFileSync(new URL('../package.json', import.meta.url), path.join(runtime, 'package.json'));
  cpSync(new URL('../src', import.meta.url), path.join(runtime, 'src'), { recursive: true });
  mkdirSync(path.join(runtime, 'config'), { recursive: true });
  copyFileSync(new URL('../config/devbridge.example.json', import.meta.url), path.join(runtime, 'config', 'devbridge.example.json'));
  initializeRuntimeRepository(runtime);

  const result = spawnSync(process.execPath, [launcher, 'doctor', '--home', home, '--no-update'], {
    cwd: downloadDir,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  assert.match(result.stdout, /Created safe local config/u);
  assert.match(result.stdout, /setup=required/u);
  assert.equal(existsSync(path.join(home, 'config.json')), true);
});
