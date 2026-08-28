import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createDefaultWindowsToolchainAuthority } from '../src/setup/windows-toolchain-authority.js';
import { reconcileWindowsProductionImageSetup } from '../src/app/windows-production-image-setup.js';

function mediaAuthority() {
  return {
    protocol: 'devbridge/windows-install-media-authority-v1',
    media: { name: 'Windows.iso', bytes: 100, sha256: 'a'.repeat(64) },
    approval: {
      sourceClass: 'official-owned',
      expectedSha256: 'a'.repeat(64),
      reference: 'https://www.microsoft.com/en-us/software-download/windows11',
      temporary: false,
    },
    image: {
      container: 'wim',
      index: 6,
      name: 'Windows 11 Pro',
      edition: 'Professional',
      architecture: 'amd64',
      version: '10.0.26100.1',
      build: 26100,
      installationType: 'Client',
      languages: ['en-US'],
      defaultLanguage: 'en-US',
    },
  };
}

function options(overrides = {}) {
  return {
    home: path.join(os.tmpdir(), 'devbridge-windows-production-setup'),
    stateDirectory: path.join(os.tmpdir(), 'devbridge-windows-production-setup', 'state'),
    platform: 'win32',
    invoke: async () => {},
    ...overrides,
  };
}

test('Windows production setup reports media-required without constructing a canary', async () => {
  let canaries = 0;
  const result = await reconcileWindowsProductionImageSetup(options(), {
    mediaResolver: async () => null,
    canaryFactory: () => { canaries += 1; },
  });
  assert.equal(result.state, 'media-required');
  assert.equal(result.physical, null);
  assert.equal(canaries, 0);
});

test('Windows production setup binds accepted media to one exact read-only canary status', async () => {
  const sourceLocation = path.join(os.tmpdir(), 'owned-Windows.iso');
  const payload = { protocol: 'devbridge/windows-guest-image-payload-v1', generation: 'guest-image-0123456789abcdef01234567', files: [] };
  const calls = [];
  const result = await reconcileWindowsProductionImageSetup(options(), {
    mediaResolver: async () => ({ location: sourceLocation, authority: mediaAuthority() }),
    payloadFactory: async () => payload,
    toolAuthorityFactory: createDefaultWindowsToolchainAuthority,
    canaryFactory: (config, dependencies) => {
      calls.push(['config', structuredClone(config)]);
      return {
        async status() {
          calls.push(['status']);
          assert.equal((await dependencies.payloadFactory()).generation, payload.generation);
          return { protocol: 'test/physical-v1', state: 'absent', complete: false, blocked: false, reason: null, preflight: { ready: true } };
        },
        async run() { calls.push(['run']); throw new Error('setup observation must not construct'); },
      };
    },
  });

  assert.equal(result.state, 'ready');
  assert.deepEqual(calls.map(([name]) => name), ['config', 'status']);
  const config = calls[0][1];
  assert.equal(config.sourceLocation, sourceLocation);
  assert.equal(config.authority.media.media.sha256, 'a'.repeat(64));
  assert.equal(config.authority.tools.generation, 'windows-build-basics-20260828-v2');
  assert.equal(config.authority.payload.generation, payload.generation);
  assert.deepEqual(config.authority.recipe, { generation: 'audit-handoff-v1' });
  assert.deepEqual(config.authority.output, {
    profile: 'windows-development',
    generation: 'windows-production-v1',
    bootstrap: payload.generation,
  });
  assert.deepEqual(config.resources, {
    memoryBytes: 4 * 1024 ** 3,
    processorCount: 2,
    diskBytes: 64 * 1024 ** 3,
    allocationBytes: 40 * 1024 ** 3,
  });
  assert.equal(JSON.stringify(result).includes(sourceLocation), false);
});

test('Windows production setup preserves bounded physical blockers without running them', async () => {
  let runs = 0;
  const result = await reconcileWindowsProductionImageSetup(options(), {
    mediaResolver: async () => ({ location: path.join(os.tmpdir(), 'owned-Windows.iso'), authority: mediaAuthority() }),
    payloadFactory: async () => ({ generation: 'guest-image-0123456789abcdef01234567' }),
    canaryFactory: () => ({
      async status() { return { state: 'blocked', complete: false, blocked: true, reason: 'provider prerequisite is unavailable' }; },
      async run() { runs += 1; },
    }),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.reason, 'provider prerequisite is unavailable');
  assert.equal(runs, 0);
});

test('Windows production setup bounds dependency failures and stays unattached on other hosts', async () => {
  const secretLocation = path.join(os.tmpdir(), 'private-Windows.iso');
  const blocked = await reconcileWindowsProductionImageSetup(options(), {
    mediaResolver: async () => { throw new Error(`failed at ${secretLocation}`); },
  });
  assert.equal(blocked.state, 'blocked');
  assert.equal(JSON.stringify(blocked).includes(secretLocation), false);

  let resolved = false;
  const unavailable = await reconcileWindowsProductionImageSetup(options({ platform: 'linux' }), {
    mediaResolver: async () => { resolved = true; },
  });
  assert.equal(unavailable.state, 'platform-unavailable');
  assert.equal(resolved, false);
});
