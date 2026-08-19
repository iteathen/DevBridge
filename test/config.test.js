import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function base() {
  return {
    version: 1,
    github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.resolve('/tmp/patch-poller-workspace'), allowedOwners: ['iteathen'] },
    state: { directory: path.resolve('/tmp/patch-poller-state') },
    execution: {},
    status: {},
    tools: {}
  };
}

test('uses conservative API, auth, execution, Git, publication, context-rollover, and tool-onboarding defaults', () => {
  const config = validateConfig(base());
  assert.equal(config.github.apiVersion, '2026-03-10');
  assert.equal(config.github.rateLimit.reserveRatio, 0.2);
  assert.equal(config.github.auth.mode, 'auto');
  assert.deepEqual(config.github.auth.environmentVariables, [
    'PATCH_POLLER_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]);
  assert.equal(config.github.auth.githubCliExecutable, 'gh');
  assert.equal(config.github.auth.hostname, 'github.com');
  assert.equal(config.execution.enabled, false);
  assert.deepEqual(config.execution.decisionAuthorities, {});
  assert.equal(config.execution.decisionApprovalTtlMs, 86_400_000);
  assert.equal(config.execution.architectureGateFileThreshold, 20);
  assert.equal(config.execution.architectureGateOwnerThreshold, 4);
  assert.deepEqual(config.execution.toolOnboarding, {
    enabled: false,
    manifestDirectory: null,
    autoIntegrate: [],
    maxHelpBytes: 262_144,
    probeTimeoutMs: 15_000,
  });
  assert.deepEqual(config.workspace.externalReadRoots, []);
  assert.equal(config.git.executable, 'git');
  assert.equal(config.publication.autoPushTaskBranches, false);
  assert.equal(config.publication.branchPrefix, 'patchpoller');
  assert.deepEqual(config.contextRollover, {
    enabled: true,
    unit: 'bytes',
    capacityUnits: 1_000_000,
    softRatio: 0.55,
    preferredRatio: 0.65,
    hardRatio: 0.75,
    maxHandoffBytes: 32_768,
    maxRetained: 8,
  });
});

test('context rollover policy is local, explicit, and bounded', () => {
  const raw = base();
  raw.contextRollover = {
    enabled: false,
    unit: 'proxy',
    capacityUnits: 20_000,
    softRatio: 0.4,
    preferredRatio: 0.6,
    hardRatio: 0.8,
    maxHandoffBytes: 65_536,
    maxRetained: 12,
  };
  assert.deepEqual(validateConfig(raw).contextRollover, raw.contextRollover);

  raw.contextRollover.softRatio = 0.7;
  raw.contextRollover.preferredRatio = 0.6;
  assert.throws(() => validateConfig(raw), /softRatio < preferredRatio < hardRatio/u);
  raw.contextRollover.softRatio = 0.4;
  raw.contextRollover.preferredRatio = 0.6;
  raw.contextRollover.maxHandoffBytes = 262_145;
  assert.throws(() => validateConfig(raw), /maxHandoffBytes must be <= 262144/u);
  raw.contextRollover.maxHandoffBytes = 65_536;
  raw.contextRollover.unit = 'guess';
  assert.throws(() => validateConfig(raw), /tokens, bytes, or proxy/u);
});

test('local tool onboarding is disabled by default and requires an exact local manifest/policy boundary when enabled', () => {
  const raw = base();
  const manifestDirectory = path.resolve('/tmp/patch-poller-local-operations');
  raw.execution.toolOnboarding = {
    enabled: true,
    manifestDirectory,
    autoIntegrate: [
      { command: 'rg', operation: 'tool.rg', helpArgs: ['--help'] },
      { command: 'uv' },
    ],
    maxHelpBytes: 65_536,
    probeTimeoutMs: 8_000,
  };
  const config = validateConfig(raw);
  assert.deepEqual(config.execution.toolOnboarding, {
    enabled: true,
    manifestDirectory,
    autoIntegrate: [
      { command: 'rg', operation: 'tool.rg', helpArgs: ['--help'] },
      { command: 'uv', operation: 'tool.uv', helpArgs: ['--help'] },
    ],
    maxHelpBytes: 65_536,
    probeTimeoutMs: 8_000,
  });

  const missingManifest = base();
  missingManifest.execution.toolOnboarding = { enabled: true, autoIntegrate: [{ command: 'rg' }] };
  assert.throws(() => validateConfig(missingManifest), /manifestDirectory is required/u);

  const unsafeCommand = base();
  unsafeCommand.execution.toolOnboarding = {
    enabled: true,
    manifestDirectory,
    autoIntegrate: [{ command: 'rg;rm' }],
  };
  assert.throws(() => validateConfig(unsafeCommand), /command is invalid/u);

  const unsafeHelp = base();
  unsafeHelp.execution.toolOnboarding = {
    enabled: true,
    manifestDirectory,
    autoIntegrate: [{ command: 'rg', helpArgs: ['help;rm'] }],
  };
  assert.throws(() => validateConfig(unsafeHelp), /fixed safe option arguments/u);
});

test('legacy github.tokenEnv remains first while standard environment fallbacks are added', () => {
  const raw = base();
  raw.github.tokenEnv = 'UAI_GITHUB_TOKEN';
  const config = validateConfig(raw);
  assert.deepEqual(config.github.auth.environmentVariables, [
    'UAI_GITHUB_TOKEN',
    'PATCH_POLLER_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]);
  assert.equal(config.github.tokenEnv, 'UAI_GITHUB_TOKEN');
});

test('explicit GitHub auth configuration can constrain the local credential method', () => {
  const raw = base();
  raw.github.auth = {
    mode: 'environment',
    environmentVariables: ['LOCAL_ONLY_GITHUB_TOKEN'],
    githubCliExecutable: 'gh-custom',
    hostname: 'github.example.com',
  };
  const config = validateConfig(raw);
  assert.deepEqual(config.github.auth, {
    mode: 'environment',
    environmentVariables: ['LOCAL_ONLY_GITHUB_TOKEN'],
    githubCliExecutable: 'gh-custom',
    hostname: 'github.example.com',
  });
});

test('GitHub auth rejects unsafe environment-variable names', () => {
  const raw = base();
  raw.github.auth = {
    mode: 'auto',
    environmentVariables: ['GH_TOKEN;evil'],
  };
  assert.throws(() => validateConfig(raw), /environment-variable name/u);
});

test('normalizes local per-class decision authority and hard-gate bounds', () => {
  const raw = base();
  raw.execution.decisionAuthorities = {
    'security-capability': ['1775584', '1775585', '1775584'],
    'public-contract': ['1775584'],
  };
  raw.execution.decisionApprovalTtlMs = 3_600_000;
  raw.execution.architectureGateFileThreshold = 12;
  raw.execution.architectureGateOwnerThreshold = 3;

  const config = validateConfig(raw);
  assert.deepEqual(config.execution.decisionAuthorities, {
    'security-capability': ['1775584', '1775585'],
    'public-contract': ['1775584'],
  });
  assert.equal(config.execution.decisionApprovalTtlMs, 3_600_000);
  assert.equal(config.execution.architectureGateFileThreshold, 12);
  assert.equal(config.execution.architectureGateOwnerThreshold, 3);
});

test('rejects malformed or authority-expanding hard-gate configuration', () => {
  const unknown = base();
  unknown.execution.decisionAuthorities = { 'filesystem.unrestricted': ['1775584'] };
  assert.throws(() => validateConfig(unknown), /not a supported local decision class/u);

  const empty = base();
  empty.execution.decisionAuthorities = { 'security-capability': [] };
  assert.throws(() => validateConfig(empty), /must contain 1-32 numeric GitHub actor IDs/u);

  const nonNumeric = base();
  nonNumeric.execution.decisionAuthorities = { 'security-capability': ['iteathen'] };
  assert.throws(() => validateConfig(nonNumeric), /numeric GitHub actor IDs/u);

  const ttl = base();
  ttl.execution.decisionApprovalTtlMs = 59_999;
  assert.throws(() => validateConfig(ttl), /decisionApprovalTtlMs/u);

  const broad = base();
  broad.execution.architectureGateFileThreshold = 1;
  assert.throws(() => validateConfig(broad), /architectureGateFileThreshold/u);
});
