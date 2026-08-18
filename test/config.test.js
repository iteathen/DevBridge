import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function base() {
  return { version: 1, github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} }, workspace: { root: path.resolve('/tmp/patch-poller-workspace'), allowedOwners: ['iteathen'] }, state: { directory: path.resolve('/tmp/patch-poller-state') }, execution: {}, status: {}, tools: {} };
}

test('uses conservative API, auth, execution, Git, publication, sandbox, decision, and context-rollover defaults', () => {
  const config = validateConfig(base());
  assert.equal(config.github.apiVersion, '2026-03-10');
  assert.equal(config.github.rateLimit.reserveRatio, 0.2);
  assert.equal(config.github.auth.mode, 'auto');
  assert.deepEqual(config.github.auth.environmentVariables, ['PATCH_POLLER_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
  assert.equal(config.github.auth.githubCliExecutable, 'gh');
  assert.equal(config.github.auth.hostname, 'github.com');
  assert.equal(config.execution.enabled, false);
  assert.deepEqual(config.workspace.externalReadRoots, []);
  assert.deepEqual(config.execution.sandbox, { provider: 'auto', readRoots: [], bubblewrapExecutable: 'bwrap', windowsSandboxExecutable: 'wsb', verificationTimeoutMs: 120_000 });
  assert.deepEqual(config.decisions.authorityClasses, { 'security-change': ['1775584'] });
  assert.equal(config.decisions.checkpointTtlMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(config.git.executable, 'git');
  assert.equal(config.publication.autoPushTaskBranches, false);
  assert.equal(config.publication.branchPrefix, 'patchpoller');
  assert.deepEqual(config.contextRollover, { enabled: true, unit: 'bytes', capacityUnits: 1_000_000, softRatio: 0.55, preferredRatio: 0.65, hardRatio: 0.75, maxHandoffBytes: 32_768, maxRetained: 8 });
});

test('sandbox provider and read roots are local, explicit, and bounded', () => {
  const raw = base(); raw.execution.sandbox = { provider: 'bubblewrap', readRoots: [path.resolve('/opt/toolchain')], verificationTimeoutMs: 30_000 };
  const observed = validateConfig(raw).execution.sandbox;
  assert.equal(observed.provider, 'bubblewrap'); assert.deepEqual(observed.readRoots, [path.resolve('/opt/toolchain')]); assert.equal(observed.verificationTimeoutMs, 30_000);
  raw.execution.sandbox.provider = 'declared-is-enforced'; assert.throws(() => validateConfig(raw), /provider must be auto, none, bubblewrap, or windows-sandbox/u);
  raw.execution.sandbox.provider = 'bubblewrap'; raw.execution.sandbox.readRoots = ['relative/toolchain']; assert.throws(() => validateConfig(raw), /must be an absolute path/u);
});

test('decision authority is local configuration and cannot be expressed as a non-numeric remote identity', () => {
  const raw = base(); raw.decisions = { authorityClasses: { 'security-change': ['111'], architecture: ['222'] }, checkpointTtlMs: 120_000 };
  const observed = validateConfig(raw).decisions;
  assert.deepEqual(observed.authorityClasses, { 'security-change': ['111'], architecture: ['222'] });
  assert.equal(observed.checkpointTtlMs, 120_000);
  raw.decisions.authorityClasses.architecture = ['remote-capability-name'];
  assert.throws(() => validateConfig(raw), /numeric GitHub user IDs/u);
});

test('context rollover policy is local, explicit, and bounded', () => {
  const raw = base(); raw.contextRollover = { enabled: false, unit: 'proxy', capacityUnits: 20_000, softRatio: 0.4, preferredRatio: 0.6, hardRatio: 0.8, maxHandoffBytes: 65_536, maxRetained: 12 };
  assert.deepEqual(validateConfig(raw).contextRollover, raw.contextRollover);
  raw.contextRollover.softRatio = 0.7; raw.contextRollover.preferredRatio = 0.6; assert.throws(() => validateConfig(raw), /softRatio < preferredRatio < hardRatio/u);
  raw.contextRollover.softRatio = 0.4; raw.contextRollover.preferredRatio = 0.6; raw.contextRollover.maxHandoffBytes = 262_145; assert.throws(() => validateConfig(raw), /maxHandoffBytes must be <= 262144/u);
  raw.contextRollover.maxHandoffBytes = 65_536; raw.contextRollover.unit = 'guess'; assert.throws(() => validateConfig(raw), /tokens, bytes, or proxy/u);
});

test('legacy github.tokenEnv remains first while standard environment fallbacks are added', () => {
  const raw = base(); raw.github.tokenEnv = 'UAI_GITHUB_TOKEN'; const config = validateConfig(raw);
  assert.deepEqual(config.github.auth.environmentVariables, ['UAI_GITHUB_TOKEN', 'PATCH_POLLER_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']); assert.equal(config.github.tokenEnv, 'UAI_GITHUB_TOKEN');
});

test('explicit GitHub auth configuration can constrain the local credential method', () => {
  const raw = base(); raw.github.auth = { mode: 'environment', environmentVariables: ['LOCAL_ONLY_GITHUB_TOKEN'], githubCliExecutable: 'gh-custom', hostname: 'github.example.com' };
  assert.deepEqual(validateConfig(raw).github.auth, { mode: 'environment', environmentVariables: ['LOCAL_ONLY_GITHUB_TOKEN'], githubCliExecutable: 'gh-custom', hostname: 'github.example.com' });
});

test('GitHub auth rejects unsafe environment-variable names', () => {
  const raw = base(); raw.github.auth = { mode: 'auto', environmentVariables: ['GH_TOKEN;evil'] }; assert.throws(() => validateConfig(raw), /environment-variable name/u);
});
