import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';

function base() {
  return {
    version: 1,
    github: {
      queueRepository: 'iteathen/PATCH-POLLER',
      trustedActorIds: ['1775584']
    },
    workspace: {
      root: path.resolve('.tmp-workspace'),
      allowCreate: true,
      allowedOwners: ['iteathen']
    },
    state: { directory: path.resolve('.tmp-state') },
    execution: {},
    tools: {}
  };
}

test('validates minimal configuration and expands defaults', () => {
  const config = validateConfig(base());
  assert.equal(config.github.taskLabel, 'patch-poller:ready');
  assert.equal(config.github.auth.mode, 'auto');
  assert.deepEqual(config.github.auth.environmentVariables, ['PATCH_POLLER_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
  assert.equal(config.github.auth.githubCliExecutable, 'gh');
  assert.equal(config.github.auth.hostname, 'github.com');
  assert.deepEqual(config.workspace.externalReadRoots, []);
  assert.deepEqual(config.workspace.baselineChannels, {});
  assert.equal(config.workspace.defaultBaselineChannel, null);
  assert.equal(config.execution.maxConcurrentTasks, 1);
  assert.equal(config.execution.controllerPlansEnabled, true);
  assert.equal(config.execution.modelAdaptersEnabled, false);
  assert.equal(config.execution.defaultTool, null);
  assert.deepEqual(config.execution.decisionAuthorities, {});
  assert.equal(config.execution.decisionApprovalTtlMs, 86_400_000);
  assert.equal(config.execution.architectureGateFileThreshold, 20);
  assert.equal(config.execution.architectureGateOwnerThreshold, 4);
  assert.equal(config.contextRollover.enabled, true);
  assert.equal(config.contextRollover.unit, 'bytes');
  assert.equal(config.contextRollover.softRatio, 0.55);
  assert.equal(config.contextRollover.preferredRatio, 0.65);
  assert.equal(config.contextRollover.hardRatio, 0.75);
  assert.equal(config.contextRollover.maxHandoffBytes, 32_768);
  assert.equal(config.publication.autoPushTaskBranches, false);
  assert.equal(config.publication.forceNoOpPublication, false);
});

test('normalizes explicit GitHub credential-provider configuration', () => {
  const raw = base();
  raw.github.auth = {
    mode: 'github-cli',
    environmentVariables: ['CUSTOM_GH_TOKEN', 'GH_TOKEN'],
    githubCliExecutable: 'gh-custom',
    hostname: 'github.example.test'
  };
  const config = validateConfig(raw);
  assert.deepEqual(config.github.auth, {
    mode: 'github-cli',
    environmentVariables: ['CUSTOM_GH_TOKEN', 'GH_TOKEN'],
    githubCliExecutable: 'gh-custom',
    hostname: 'github.example.test'
  });
  assert.equal(config.github.tokenEnv, 'CUSTOM_GH_TOKEN');
});

test('rejects invalid GitHub credential-provider configuration', () => {
  const raw = base();
  raw.github.auth = { mode: 'keychain', environmentVariables: ['GH_TOKEN'] };
  assert.throws(() => validateConfig(raw), ConfigurationError);

  const invalidEnv = base();
  invalidEnv.github.auth = { mode: 'environment', environmentVariables: ['GH_TOKEN;rm'] };
  assert.throws(() => validateConfig(invalidEnv), ConfigurationError);

  const invalidHost = base();
  invalidHost.github.auth = { mode: 'github-cli', hostname: 'https://github.com' };
  assert.throws(() => validateConfig(invalidHost), ConfigurationError);
});

test('validates local per-class decision authority and hard-gate bounds', () => {
  const raw = base();
  raw.execution = {
    decisionAuthorities: {
      'security-capability': ['1775584', '1775585', '1775584'],
      'public-contract': ['1775584'],
    },
    decisionApprovalTtlMs: 3_600_000,
    architectureGateFileThreshold: 12,
    architectureGateOwnerThreshold: 3,
  };
  const config = validateConfig(raw);
  assert.deepEqual(config.execution.decisionAuthorities, {
    'security-capability': ['1775584', '1775585'],
    'public-contract': ['1775584'],
  });
  assert.equal(config.execution.decisionApprovalTtlMs, 3_600_000);
  assert.equal(config.execution.architectureGateFileThreshold, 12);
  assert.equal(config.execution.architectureGateOwnerThreshold, 3);
});

test('rejects remote-style or malformed hard-gate authority configuration', () => {
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
  assert.throws(() => validateConfig(ttl), ConfigurationError);

  const broad = base();
  broad.execution.architectureGateFileThreshold = 1;
  assert.throws(() => validateConfig(broad), ConfigurationError);
});

test('validates local semantic baseline channels without accepting arbitrary refs', () => {
  const raw = base();
  raw.workspace.baselineChannels = {
    production: 'main',
    testing: 'sol/foundation-bootstrap'
  };
  raw.workspace.defaultBaselineChannel = 'testing';
  const config = validateConfig(raw);
  assert.deepEqual(config.workspace.baselineChannels, raw.workspace.baselineChannels);
  assert.equal(config.workspace.defaultBaselineChannel, 'testing');

  raw.workspace.baselineChannels.bad = '../escape';
  assert.throws(() => validateConfig(raw), /safe branch name/u);
});

test('rejects an unknown default baseline channel', () => {
  const raw = base();
  raw.workspace.baselineChannels = { production: 'main' };
  raw.workspace.defaultBaselineChannel = 'testing';
  assert.throws(() => validateConfig(raw), /must name a configured local baseline channel/u);
});

test('validates deterministic fault injection as local-only bounded policy', () => {
  const raw = base();
  raw.execution.faultInjection = {
    enabled: true,
    rules: [{ id: 'truncate-probe', hook: 'process.after-exit', operation: 'node.*', action: 'truncate-output', remaining: 2 }]
  };
  const config = validateConfig(raw);
  assert.equal(config.execution.faultInjection.enabled, true);
  assert.equal(config.execution.faultInjection.rules[0].id, 'truncate-probe');
  assert.equal(config.execution.faultInjection.rules[0].remaining, 2);
});

test('rejects unsafe or malformed deterministic fault injection rules', () => {
  const raw = base();
  raw.execution.faultInjection = {
    enabled: true,
    rules: [{ id: 'bad', hook: 'process.after-exit', action: 'shell', remaining: 1 }]
  };
  assert.throws(() => validateConfig(raw), /faultInjection/u);
});

test('validates coordinating context rollover thresholds and ordering', () => {
  const raw = base();
  raw.contextRollover = {
    enabled: true,
    unit: 'tokens',
    capacityUnits: 200_000,
    softRatio: 0.5,
    preferredRatio: 0.62,
    hardRatio: 0.71,
    maxHandoffBytes: 65_536,
    maxRetained: 10,
  };
  const config = validateConfig(raw);
  assert.equal(config.contextRollover.unit, 'tokens');
  assert.equal(config.contextRollover.capacityUnits, 200_000);
  assert.equal(config.contextRollover.hardRatio, 0.71);
  assert.equal(config.contextRollover.maxRetained, 10);

  raw.contextRollover.preferredRatio = 0.49;
  assert.throws(() => validateConfig(raw), /softRatio < preferredRatio < hardRatio/u);
});
