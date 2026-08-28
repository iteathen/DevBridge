import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { formatSetupHandoff, runDevBridgeSetup } from '../src/app/setup.js';

function repository(index, overrides = {}) {
  return {
    id: index + 1,
    full_name: `owner/repo-${index}`,
    private: false,
    archived: false,
    disabled: false,
    permissions: { push: true },
    ...overrides,
  };
}

function persistedState({ identity = { id: 42, login: 'owner' }, selected = [], snapshot = '20260820T170000Z' } = {}) {
  return {
    protocol: 'devbridge/setup-status-v1',
    identity,
    repositories: { selected },
    ubuntu: { snapshot },
  };
}

function acceptedWindowsMedia() {
  return {
    protocol: 'devbridge/windows-install-media-selection-status-v1',
    state: 'accepted',
    candidates: [],
    rejectedCount: 0,
    accepted: {
      candidate: 'candidate-0123456789abcdef0123456789abcdef',
      authority: 'subject-0123456789abcdef0123456789abcdef',
      sourceClass: 'official-owned',
      temporary: false,
      media: { name: 'Windows.iso', bytes: 100, sha256: 'a'.repeat(64) },
      image: { index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', build: 26100 },
    },
  };
}

function windowsPhysical(state = 'ready', { complete = false, blocked = false, reason = null } = {}) {
  return {
    protocol: 'devbridge/windows-production-image-setup-status-v1',
    state,
    reason,
    physical: { state, complete, blocked, reason },
  };
}

function memoryStore(initial = null) {
  let value = initial;
  return {
    async get() { return structuredClone(value); },
    async set(_key, next) { value = structuredClone(next); },
    value: () => structuredClone(value),
  };
}

function dependencies({
  count = 2,
  repositories = null,
  identity = { id: 42, login: 'owner' },
  physical = null,
  prerequisite = null,
  lifecycleAuthority = null,
  environmentActivation = null,
  environmentActivationByProfile = null,
  activationProfiles = null,
  operationalConfiguration = null,
  resourceConflict = null,
  acceptedConflict = null,
  initialState = null,
  profileSelection = null,
  windowsMedia = null,
  windowsConstruction = null,
  windowsAdvance = null,
  physicalAdvance = null,
} = {}) {
  const store = memoryStore(initialState);
  let conflictConsent = acceptedConflict;
  const calls = { profileSelection: 0, profileSelectionRequest: null, windowsMedia: 0, windowsMediaRequest: null, windowsConstruction: 0, windowsConstructionActions: [], prerequisite: 0, profileConfiguration: 0, profileSourceCount: 0, resourceConflict: 0, conflictSaved: 0, conflictCleared: 0, lifecycleAuthority: 0, lifecycleClient: 0, environmentActivation: 0, environmentActivationProfiles: [], operationalConfiguration: 0, operationalRequest: null, authority: 0, canaryStatus: 0, canaryRun: 0 };
  const discoveredRepositories = repositories ?? Array.from({ length: count }, (_, index) => repository(index));
  const configuredProfiles = activationProfiles ?? profileSelection?.profiles ?? ['linux-development'];
  return {
    calls,
    store,
    deps: {
      platform: 'win32',
      now: () => new Date('2026-08-23T20:00:00Z'),
      storeFactory: () => store,
      profileSelectionReconciler: async (value) => {
        calls.profileSelection += 1;
        calls.profileSelectionRequest = structuredClone(value);
        return structuredClone(profileSelection ?? {
          protocol: 'devbridge/setup-profile-selection-status-v1',
          state: 'accepted',
          revision: 1,
          changed: false,
          profiles: ['linux-development'],
          pendingProfiles: null,
          source: 'accepted',
        });
      },
      pathInstaller: async ({ home }) => ({ protocol: 'test/path', command: path.join(home, 'bin', 'devbridge.cmd'), persisted: true, changed: false, requiresNewShell: false, temporaryCommand: null }),
      tokenResolver: async () => 'test-token',
      clientFactory: () => ({}),
      discover: async () => ({ identity, repositories: discoveredRepositories }),
      windowsMediaReconciler: async (value) => {
        calls.windowsMedia += 1;
        calls.windowsMediaRequest = structuredClone({
          home: value.home,
          stateDirectory: value.stateDirectory,
          platform: value.platform,
          discover: value.discover,
          location: value.location,
          approval: value.approval,
        });
        return structuredClone(windowsMedia ?? {
          protocol: 'devbridge/windows-install-media-selection-status-v1',
          state: 'platform-unavailable',
          candidates: [],
          rejectedCount: 0,
          accepted: null,
        });
      },
      windowsConstructionReconciler: async (value) => {
        calls.windowsConstruction += 1;
        calls.windowsConstructionActions.push(value.action);
        if (value.action === 'advance' && windowsAdvance != null) return structuredClone(windowsAdvance);
        return structuredClone(windowsConstruction ?? {
          protocol: 'devbridge/windows-production-image-setup-status-v1',
          state: 'platform-unavailable',
          reason: null,
          physical: null,
        });
      },
      prerequisiteReconciler: async () => {
        calls.prerequisite += 1;
        return prerequisite ?? { protocol: 'test/prerequisites', ready: true, blocker: null, changed: false, restartRequired: false, capabilities: {} };
      },
      profileConfigurationPublisher: ({ sources }) => ({
        async reconcile() {
          calls.profileConfiguration += 1;
          calls.profileSourceCount = sources.length;
          return {
            changed: false,
            record: { configuration: { declarations: configuredProfiles.map((profile) => ({ profile })) } },
          };
        },
      }),
      profileConfigurationFactory: () => ({}),
      resourceConflictFactory: async () => ({
        async inspect() {
          calls.resourceConflict += 1;
          return resourceConflict ?? { protocol: 'devbridge/setup-resource-conflict-v1', state: 'clear', subject: null, reason: null };
        },
        async retire() { throw new Error('clear setup conflict must not retire'); },
      }),
      resourceConflictConsentStoreFactory: () => ({
        async load() { return conflictConsent; },
        async save(value) { conflictConsent = structuredClone(value); calls.conflictSaved += 1; return value; },
        async clear() { const changed = conflictConsent != null; conflictConsent = null; calls.conflictCleared += changed ? 1 : 0; return changed; },
      }),
      lifecycleAuthorityReconciler: async () => {
        calls.lifecycleAuthority += 1;
        return lifecycleAuthority ?? { protocol: 'test/lifecycle-authority', ready: true, blocker: null, changed: false, service: 'ready', protectedState: 'ready' };
      },
      lifecycleClientFactory: () => { calls.lifecycleClient += 1; return {}; },
      environmentActivationReconciler: async ({ profile }) => {
        calls.environmentActivation += 1;
        calls.environmentActivationProfiles.push(profile);
        return environmentActivationByProfile?.[profile]
          ?? environmentActivation
          ?? { ready: true, changed: true, state: 'ready', environmentCount: 1 };
      },
      operationalConfigurationFactory: () => ({
        async reconcile(value) {
          calls.operationalConfiguration += 1;
          calls.operationalRequest = structuredClone(value);
          return operationalConfiguration ?? { ready: true, changed: true, executionEnabled: true, blocker: null };
        },
      }),
      releaseAuthority: async ({ home }) => ({ keyring: path.join(home, 'authority', 'ubuntu.gpg') }),
      authorityFactory: async ({ snapshot }) => { calls.authority += 1; return { protocol: 'test/authority', snapshot }; },
      canaryFactory: () => ({
        async status() {
          calls.canaryStatus += 1;
          return physical ?? { state: 'absent', blocked: false, complete: false, reason: null, preflight: { ready: true } };
        },
        async run() {
          calls.canaryRun += 1;
          if (physicalAdvance != null) return structuredClone(physicalAdvance);
          throw new Error('setup must never construct');
        },
      }),
    },
  };
}

test('setup reaches the physical status gate without invoking construction', async () => {
  const fixture = dependencies();
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-test') }, fixture.deps);
  assert.equal(result.readyForConstruction, true);
  assert.equal(result.phase, 'ready-for-construction');
  assert.equal(result.repositories.selectedCount, 2);
  assert.deepEqual(result.profileSelection.profiles, ['linux-development']);
  assert.equal(result.windowsProfile, null);
  assert.equal(result.lifecycleAuthority, null);
  assert.equal(fixture.calls.profileSelection, 1);
  assert.equal(fixture.calls.windowsMedia, 0);
  assert.equal(fixture.calls.prerequisite, 1);
  assert.equal(fixture.calls.profileConfiguration, 0);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.canaryStatus, 1);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup composes protected configuration and environment activation only after image completion', async () => {
  const fixture = dependencies({
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-environment-ready') }, fixture.deps);
  assert.equal(result.blocked, false);
  assert.equal(result.phase, 'operational-ready');
  assert.deepEqual(result.environment, {
    ready: true,
    changed: true,
    state: 'ready',
    profile: 'linux-development',
    environmentCount: 1,
    profileCount: 1,
  });
  assert.equal(Object.hasOwn(result.environment, 'environmentIdentity'), false);
  assert.equal(fixture.calls.profileConfiguration, 1);
  assert.equal(fixture.calls.lifecycleAuthority, 1);
  assert.equal(fixture.calls.lifecycleClient, 1);
  assert.equal(fixture.calls.environmentActivation, 1);
  assert.equal(fixture.calls.operationalConfiguration, 1);
  assert.deepEqual(fixture.calls.operationalRequest, {
    protocol: 'devbridge/setup-operational-configuration-request-v1',
    targets: ['owner/repo-0', 'owner/repo-1'],
    submitters: ['42'],
    owners: ['owner'],
  });
  assert.equal(fixture.calls.canaryStatus, 1);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('deferred and empty profile selections preserve repository setup without crossing platform boundaries', async () => {
  const deferredFixture = dependencies({
    initialState: persistedState({
      selected: [{ id: 1, fullName: 'owner/repo-0', private: false }],
      snapshot: '20260820T170000Z',
    }),
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'deferred', revision: 4, changed: false,
      profiles: ['linux-development'], pendingProfiles: ['windows-development'], source: 'explicit',
    },
  });
  const deferred = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-profiles-deferred'), profileChoice: 'defer', discoverWindowsMedia: true,
  }, deferredFixture.deps);
  assert.equal(deferred.phase, 'profile-selection-deferred');
  assert.equal(deferred.blocked, false);
  assert.equal(deferred.repositories.selectedCount, 1);
  assert.equal(deferredFixture.store.value().ubuntu.snapshot, '20260820T170000Z');
  assert.equal(deferredFixture.calls.profileSelectionRequest.choice, 'defer');
  assert.equal(deferredFixture.calls.windowsMedia, 0);
  assert.equal(deferredFixture.calls.prerequisite, 0);
  assert.equal(deferredFixture.calls.authority, 0);
  assert.equal(deferredFixture.calls.canaryStatus, 0);
  assert.equal(deferredFixture.calls.lifecycleAuthority, 0);
  assert.equal(deferredFixture.calls.operationalConfiguration, 0);
  assert.match(formatSetupHandoff(deferred), /no profile setup work was performed/u);

  const emptyFixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 5, changed: true,
      profiles: [], pendingProfiles: null, source: 'explicit',
    },
  });
  const empty = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-profiles-empty'), profileChoice: 'none', discoverWindowsMedia: true,
  }, emptyFixture.deps);
  assert.equal(empty.phase, 'profiles-disabled');
  assert.equal(empty.blocked, false);
  assert.equal(empty.linuxProfile, null);
  assert.equal(empty.windowsProfile, null);
  assert.equal(emptyFixture.calls.windowsMedia, 0);
  assert.equal(emptyFixture.calls.prerequisite, 0);
  assert.equal(emptyFixture.calls.operationalConfiguration, 0);
  assert.match(formatSetupHandoff(empty), /repository execution remains unavailable/u);
});

test('Windows-only selection observes only its local setup boundary and remains fail-closed', async () => {
  const fixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 2, changed: true,
      profiles: ['windows-development'], pendingProfiles: null, source: 'explicit',
    },
    windowsMedia: {
      protocol: 'devbridge/windows-install-media-selection-status-v1', state: 'source-required',
      candidates: [], rejectedCount: 0, accepted: null,
      acquisition: { officialOwned: 'https://example.invalid/owned', evaluation: 'https://example.invalid/evaluation' },
      inbox: 'C:\\managed\\media',
    },
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-windows-only'), profileChoice: 'windows', discoverWindowsMedia: true,
  }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.match(result.blocker, /requires an accepted install-media source/u);
  assert.equal(result.linuxProfile, null);
  assert.equal(result.windowsProfile.media.state, 'source-required');
  assert.equal(fixture.calls.windowsMedia, 1);
  assert.equal(fixture.calls.prerequisite, 0);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);
  assert.equal(fixture.calls.resourceConflict, 0);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.operationalConfiguration, 0);
});

test('Windows-only selection reaches protected activation after exact image completion without Linux work', async () => {
  const fixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 2, changed: false,
      profiles: ['windows-development'], pendingProfiles: null, source: 'accepted',
    },
    windowsMedia: acceptedWindowsMedia(),
    windowsConstruction: windowsPhysical('complete', { complete: true }),
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-windows-activation'),
  }, fixture.deps);

  assert.equal(result.blocked, false);
  assert.equal(result.phase, 'operational-ready');
  assert.deepEqual(result.environment, {
    ready: true,
    changed: true,
    state: 'ready',
    profile: 'windows-development',
    environmentCount: 1,
    profileCount: 1,
  });
  assert.equal(fixture.calls.profileSourceCount, 1);
  assert.deepEqual(fixture.calls.environmentActivationProfiles, ['windows-development']);
  assert.equal(fixture.calls.prerequisite, 0);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);
  assert.equal(fixture.calls.lifecycleAuthority, 1);
  assert.equal(fixture.calls.operationalConfiguration, 1);
  assert.match(formatSetupHandoff(result), /1 selected environment\(s\) verified/u);
});

test('multi-profile activation advances one changed environment and resumes in accepted order', async () => {
  const profileSelection = {
    protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 3, changed: false,
    profiles: ['linux-development', 'windows-development'], pendingProfiles: null, source: 'accepted',
  };
  const imageState = {
    profileSelection,
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    windowsMedia: acceptedWindowsMedia(),
    windowsConstruction: windowsPhysical('complete', { complete: true }),
  };
  const first = dependencies({
    ...imageState,
    environmentActivationByProfile: {
      'linux-development': { ready: true, changed: true, state: 'ready' },
      'windows-development': { ready: true, changed: true, state: 'ready' },
    },
  });
  const pending = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-activation-first'),
  }, first.deps);
  assert.equal(pending.blocked, true);
  assert.match(pending.blocker, /Additional accepted environment profile activation remains/u);
  assert.deepEqual(pending.environment, {
    ready: false,
    changed: true,
    state: 'pending',
    profile: 'linux-development',
    environmentCount: 1,
    profileCount: 2,
  });
  assert.deepEqual(first.calls.environmentActivationProfiles, ['linux-development']);
  assert.equal(first.calls.operationalConfiguration, 0);

  const second = dependencies({
    ...imageState,
    environmentActivationByProfile: {
      'linux-development': { ready: true, changed: false, state: 'ready' },
      'windows-development': { ready: true, changed: true, state: 'ready' },
    },
  });
  const ready = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-activation-second'),
  }, second.deps);
  assert.equal(ready.blocked, false);
  assert.equal(ready.phase, 'operational-ready');
  assert.deepEqual(ready.environment, {
    ready: true,
    changed: true,
    state: 'ready',
    profile: 'windows-development',
    environmentCount: 2,
    profileCount: 2,
  });
  assert.deepEqual(second.calls.environmentActivationProfiles, ['linux-development', 'windows-development']);
  assert.equal(second.calls.operationalConfiguration, 1);
});

test('multi-profile activation never skips a blocked earlier environment', async () => {
  const fixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 3, changed: false,
      profiles: ['linux-development', 'windows-development'], pendingProfiles: null, source: 'accepted',
    },
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    windowsMedia: acceptedWindowsMedia(),
    windowsConstruction: windowsPhysical('complete', { complete: true }),
    environmentActivationByProfile: {
      'linux-development': { ready: false, changed: false, state: 'blocked', blocker: 'accepted environment requires review' },
      'windows-development': { ready: true, changed: true, state: 'ready' },
    },
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-activation-blocked'),
  }, fixture.deps);

  assert.equal(result.blocked, true);
  assert.match(result.blocker, /requires review/u);
  assert.deepEqual(fixture.calls.environmentActivationProfiles, ['linux-development']);
  assert.equal(fixture.calls.operationalConfiguration, 0);
});

test('setup rejects Windows media actions outside the selected profile before its adapter runs', async () => {
  const linux = dependencies();
  const media = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-media-without-windows'),
    windowsMediaLocation: 'C:\\media\\Windows.iso',
  }, linux.deps);
  assert.equal(media.blocked, true);
  assert.match(media.blocker, /require the selected Windows execution profile/u);
  assert.equal(linux.calls.windowsMedia, 0);
  assert.equal(linux.calls.prerequisite, 0);
});

test('Windows-only construction observes before advancing only its selected profile', async () => {
  const fixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 2, changed: false,
      profiles: ['windows-development'], pendingProfiles: null, source: 'accepted',
    },
    windowsMedia: acceptedWindowsMedia(),
    windowsConstruction: windowsPhysical(),
    windowsAdvance: windowsPhysical('waiting'),
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-windows-construction'), construct: true,
  }, fixture.deps);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.construction, { requested: true, attempted: true, profile: 'windows-development' });
  assert.deepEqual(fixture.calls.windowsConstructionActions, ['observe', 'advance']);
  assert.equal(fixture.calls.prerequisite, 0);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);
  assert.equal(fixture.calls.canaryRun, 0);
  assert.match(formatSetupHandoff(result), /Windows physical image construction canary advanced/u);
});

test('multi-profile construction advances Linux before Windows and only one frontier per invocation', async () => {
  const profileSelection = {
    protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 3, changed: false,
    profiles: ['linux-development', 'windows-development'], pendingProfiles: null, source: 'accepted',
  };
  const linux = dependencies({
    profileSelection,
    windowsMedia: acceptedWindowsMedia(),
    windowsConstruction: windowsPhysical(),
    physical: { state: 'planned', blocked: false, complete: false, reason: null, preflight: { ready: true } },
    physicalAdvance: { state: 'waiting', blocked: false, complete: false, reason: null, preflight: { ready: true } },
  });
  const linuxResult = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-serial-linux'), construct: true,
  }, linux.deps);
  assert.deepEqual(linuxResult.construction, { requested: true, attempted: true, profile: 'linux-development' });
  assert.equal(linux.calls.canaryRun, 1);
  assert.deepEqual(linux.calls.windowsConstructionActions, ['observe']);

  const windows = dependencies({
    profileSelection,
    windowsMedia: acceptedWindowsMedia(),
    windowsConstruction: windowsPhysical(),
    windowsAdvance: windowsPhysical('waiting'),
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
  });
  const windowsResult = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-serial-windows'), construct: true,
  }, windows.deps);
  assert.deepEqual(windowsResult.construction, { requested: true, attempted: true, profile: 'windows-development' });
  assert.equal(windows.calls.canaryRun, 0);
  assert.deepEqual(windows.calls.windowsConstructionActions, ['observe', 'advance']);
});

test('multi-profile construction never skips a blocked earlier profile', async () => {
  const fixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 3, changed: false,
      profiles: ['linux-development', 'windows-development'], pendingProfiles: null, source: 'accepted',
    },
    windowsMedia: acceptedWindowsMedia(),
    windowsConstruction: windowsPhysical(),
    physical: { state: 'blocked', blocked: true, complete: false, reason: 'selected profile prerequisite is unavailable', preflight: { ready: false } },
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-serial-blocked'), construct: true,
  }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.match(result.blocker, /selected profile prerequisite is unavailable/u);
  assert.deepEqual(result.construction, { requested: true, attempted: false, profile: 'linux-development' });
  assert.equal(fixture.calls.canaryRun, 0);
  assert.deepEqual(fixture.calls.windowsConstructionActions, ['observe']);
});

test('setup discovers Windows media before presenting exact approval choices without blocking Linux', async () => {
  const candidate = 'candidate-0123456789abcdef0123456789abcdef';
  const fixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 1, changed: false,
      profiles: ['linux-development', 'windows-development'], pendingProfiles: null, source: 'accepted',
    },
    windowsMedia: {
      protocol: 'devbridge/windows-install-media-selection-status-v1',
      state: 'selection-required',
      candidates: [{
        subject: candidate,
        media: { name: 'Windows.iso', bytes: 100, sha256: 'a'.repeat(64) },
        images: [{ index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', build: 26100 }],
      }],
      rejectedCount: 0,
      accepted: null,
      acquisition: {
        officialOwned: 'https://www.microsoft.com/en-us/software-download/windows11',
        evaluation: 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise',
      },
      inbox: 'C:\\managed\\media',
    },
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-windows-media-discovery'),
    discoverWindowsMedia: true,
  }, fixture.deps);

  assert.equal(result.blocked, false);
  assert.equal(result.readyForConstruction, true);
  assert.equal(result.windowsProfile.media.state, 'selection-required');
  assert.equal(fixture.calls.windowsMedia, 1);
  assert.equal(fixture.calls.windowsMediaRequest.discover, true);
  const handoff = formatSetupHandoff(result);
  assert.match(handoff, new RegExp(`--approve-windows-media ${candidate}`, 'u'));
  assert.match(handoff, /--windows-image-index 6 --windows-media-class official-owned/u);
  assert.match(handoff, /Evaluation media must be explicitly classified/u);
});

test('automatic Windows media failure remains profile-local while an explicit approval failure blocks', async () => {
  const blockedMedia = {
    protocol: 'devbridge/windows-install-media-selection-status-v1',
    state: 'blocked',
    blocker: 'Windows install media reconciliation failed; inspect the local setup evidence and retry',
    candidates: [],
    rejectedCount: 0,
    accepted: null,
  };
  const bothProfiles = {
    protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 1, changed: false,
    profiles: ['linux-development', 'windows-development'], pendingProfiles: null, source: 'accepted',
  };
  const automatic = dependencies({ profileSelection: bothProfiles, windowsMedia: blockedMedia });
  const continued = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-windows-media-optional'),
    discoverWindowsMedia: true,
  }, automatic.deps);
  assert.equal(continued.blocked, false);
  assert.equal(continued.readyForConstruction, true);
  assert.equal(continued.windowsProfile.media.state, 'blocked');

  const explicit = dependencies({ profileSelection: bothProfiles, windowsMedia: blockedMedia });
  const stopped = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-windows-media-explicit'),
    windowsMediaApproval: {
      candidate: 'candidate-0123456789abcdef0123456789abcdef',
      imageIndex: 6,
      sourceClass: 'official-owned',
    },
  }, explicit.deps);
  assert.equal(stopped.blocked, true);
  assert.match(stopped.blocker, /Windows install media reconciliation failed/u);
  assert.equal(explicit.calls.prerequisite, 0);
});

test('accepted Windows media exposes only read-only construction status and never blocks Linux progress', async () => {
  const fixture = dependencies({
    profileSelection: {
      protocol: 'devbridge/setup-profile-selection-status-v1', state: 'accepted', revision: 1, changed: false,
      profiles: ['linux-development', 'windows-development'], pendingProfiles: null, source: 'accepted',
    },
    windowsMedia: {
      protocol: 'devbridge/windows-install-media-selection-status-v1',
      state: 'accepted',
      candidates: [],
      rejectedCount: 0,
      accepted: {
        candidate: 'candidate-0123456789abcdef0123456789abcdef',
        authority: 'subject-0123456789abcdef0123456789abcdef',
        sourceClass: 'official-owned',
        temporary: false,
        media: { name: 'Windows.iso', bytes: 100, sha256: 'a'.repeat(64) },
        image: { index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', build: 26100 },
      },
    },
    windowsConstruction: {
      protocol: 'devbridge/windows-production-image-setup-status-v1',
      state: 'blocked',
      reason: 'provider prerequisite is unavailable',
      physical: { state: 'blocked', complete: false, blocked: true, reason: 'provider prerequisite is unavailable' },
    },
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-windows-construction-status') }, fixture.deps);
  assert.equal(result.blocked, false);
  assert.equal(result.readyForConstruction, true);
  assert.equal(result.windowsProfile.construction.state, 'blocked');
  assert.equal(fixture.calls.windowsConstruction, 1);
  assert.equal(fixture.calls.canaryRun, 0);
  assert.match(formatSetupHandoff(result), /Read-only construction gate blocked: provider prerequisite is unavailable/u);
});

test('setup discovers one exact inactive conflict and stops before elevation until the subject is approved', async () => {
  const subject = 'a'.repeat(64);
  const fixture = dependencies({
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    resourceConflict: {
      protocol: 'devbridge/setup-resource-conflict-v1',
      state: 'approval-required',
      subject,
      reason: 'one inactive local resource blocks protected setup',
    },
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-conflict-discovery') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.equal(result.resourceConflict.subject, subject);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.profileConfiguration, 0);
  assert.match(result.blocker, /exact operator consent/u);
  const handoff = formatSetupHandoff(result);
  assert.match(handoff, new RegExp(`Conflict consent subject: ${subject}`, 'u'));
  assert.match(handoff, new RegExp(`--retire-conflict ${subject}`, 'u'));
});

test('setup persists only the exact observed conflict subject before entering protected reconciliation', async () => {
  const subject = 'b'.repeat(64);
  const fixture = dependencies({
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    resourceConflict: {
      protocol: 'devbridge/setup-resource-conflict-v1',
      state: 'approval-required',
      subject,
      reason: 'one inactive local resource blocks protected setup',
    },
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-conflict-approved'),
    retireConflict: subject,
  }, fixture.deps);
  assert.equal(result.blocked, false);
  assert.equal(result.phase, 'operational-ready');
  assert.equal(fixture.calls.conflictSaved, 1);
  assert.equal(fixture.calls.conflictCleared, 1);
  assert.equal(fixture.calls.lifecycleAuthority, 1);
  assert.equal(fixture.calls.operationalConfiguration, 1);

  const changed = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-conflict-changed'),
    retireConflict: 'c'.repeat(64),
  }, fixture.deps);
  assert.equal(changed.blocked, true);
  assert.match(changed.blocker, /exact operator consent/u);
});

test('setup keeps the image complete but fails closed when protected environment activation is not ready', async () => {
  const fixture = dependencies({
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    environmentActivation: { ready: false, changed: false, state: 'blocked', blocker: 'accepted environment is not safely creatable through initial setup', environmentIdentity: 'environment-private' },
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-environment-blocked') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.equal(result.phase, 'blocked');
  assert.match(result.blocker, /not safely creatable/u);
  assert.deepEqual(result.environment, {
    ready: false,
    changed: false,
    state: 'blocked',
    profile: 'linux-development',
    environmentCount: 0,
    profileCount: 1,
  });
  assert.equal(fixture.calls.operationalConfiguration, 0);
  assert.equal(JSON.stringify(result).includes('environment-private'), false);
});

test('setup fails closed when publication omits an accepted profile', async () => {
  const fixture = dependencies({
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    activationProfiles: [],
  });
  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-profile-publication-incomplete'),
  }, fixture.deps);

  assert.equal(result.blocked, true);
  assert.match(result.blocker, /does not cover every selected profile/u);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.environmentActivation, 0);
  assert.equal(fixture.calls.operationalConfiguration, 0);
});

test('setup does not report completion when operational configuration fails after route readiness', async () => {
  const fixture = dependencies({
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    operationalConfiguration: { ready: false, changed: false, executionEnabled: false, blocker: 'configuration predecessor changed' },
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-operational-blocked') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.equal(result.phase, 'blocked');
  assert.match(result.blocker, /configuration predecessor changed/u);
  assert.deepEqual(result.environment, {
    ready: true,
    changed: true,
    state: 'ready',
    profile: 'linux-development',
    environmentCount: 1,
    profileCount: 1,
  });
  assert.deepEqual(result.operational, { ready: false, changed: false, executionEnabled: false });
  assert.equal(fixture.calls.operationalConfiguration, 1);
});

test('setup preserves the repository selection boundary before prerequisite or image authority work', async () => {
  const fixture = dependencies({ count: 31 });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-many') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.match(result.blocker, /31 eligible repositories/u);
  assert.equal(fixture.calls.prerequisite, 0);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup persists accepted authority before returning a focused prerequisite blocker', async () => {
  const fixture = dependencies({
    prerequisite: {
      protocol: 'test/prerequisites',
      ready: false,
      blocker: 'Windows OpenSSH Client requires elevation; re-run setup from an elevated shell',
      changed: false,
      restartRequired: false,
      capabilities: { gpgv: true, opensshClient: false },
    },
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-prerequisite-blocked') }, fixture.deps);

  assert.equal(result.blocked, true);
  assert.match(result.blocker, /OpenSSH Client requires elevation/u);
  assert.equal(result.prerequisites.ready, false);
  assert.equal(fixture.store.value().identity.id, 42);
  assert.equal(fixture.store.value().repositories.selected.length, 2);
  assert.equal(fixture.calls.prerequisite, 1);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup stops at the protected lifecycle authority boundary after exact image completion', async () => {
  const fixture = dependencies({
    physical: { state: 'completed', blocked: false, complete: true, reason: null, preflight: { ready: true } },
    lifecycleAuthority: {
      protocol: 'test/lifecycle-authority',
      ready: false,
      blocker: 'Windows protected lifecycle authority requires elevation',
      changed: false,
      service: 'unavailable',
      protectedState: 'unknown',
    },
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-lifecycle-authority-blocked') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.match(result.blocker, /protected lifecycle authority requires elevation/u);
  assert.equal(result.lifecycleAuthority.ready, false);
  assert.equal(fixture.calls.prerequisite, 1);
  assert.equal(fixture.calls.profileConfiguration, 1);
  assert.equal(fixture.calls.lifecycleAuthority, 1);
  assert.equal(fixture.calls.authority, 1);
  assert.equal(fixture.calls.canaryStatus, 1);
  assert.equal(fixture.calls.canaryRun, 0);
  assert.equal(fixture.calls.environmentActivation, 0);
});

test('setup reports physical preflight blockers without crossing the status gate', async () => {
  const fixture = dependencies({ physical: { state: 'blocked', blocked: true, complete: false, reason: 'Hyper-V provider is unavailable', preflight: { ready: false } } });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-blocked') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.equal(result.readyForConstruction, false);
  assert.match(result.blocker, /Hyper-V/u);
  assert.equal(fixture.calls.prerequisite, 1);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.canaryStatus, 1);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup re-entry reuses the exact persisted package snapshot', async () => {
  const snapshot = '20260820T170000Z';
  const fixture = dependencies({ initialState: { protocol: 'devbridge/setup-status-v1', ubuntu: { snapshot } } });
  let observed = null;
  fixture.deps.authorityFactory = async ({ snapshot: value }) => { observed = value; return { protocol: 'test/authority', snapshot: value }; };
  await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-reentry') }, fixture.deps);
  assert.equal(observed, snapshot);
});

test('setup re-entry after a later authority failure returns through prerequisites and reaches status without construction', async () => {
  const fixture = dependencies();
  let releaseCalls = 0;
  fixture.deps.releaseAuthority = async ({ home }) => {
    releaseCalls += 1;
    if (releaseCalls === 1) throw new Error('injected post-prerequisite interruption');
    return { keyring: path.join(home, 'authority', 'ubuntu.gpg') };
  };

  const first = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-post-prerequisite') }, fixture.deps);
  assert.equal(first.blocked, true);
  assert.match(first.blocker, /post-prerequisite interruption/u);
  assert.equal(fixture.calls.canaryStatus, 0);

  const resumed = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-post-prerequisite') }, fixture.deps);
  assert.equal(resumed.readyForConstruction, true);
  assert.equal(fixture.calls.prerequisite, 2);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.canaryStatus, 1);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup re-entry preserves accepted stable repository identities across discovery changes', async () => {
  const fixture = dependencies({
    repositories: [repository(0, { full_name: 'owner/renamed' }), repository(1)],
    initialState: persistedState({ selected: [{ id: 1, fullName: 'owner/repo-0', private: false }] }),
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-preserved-repository') }, fixture.deps);
  assert.equal(result.readyForConstruction, true);
  assert.equal(result.repositories.selectedCount, 1);
  assert.equal(result.repositories.selected[0].id, 1);
  assert.equal(result.repositories.selected[0].fullName, 'owner/renamed');
  assert.deepEqual(fixture.store.value().repositories.selected.map((entry) => entry.id), [1]);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup re-entry preserves an accepted empty repository set', async () => {
  const fixture = dependencies({ initialState: persistedState({ selected: [] }) });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-preserved-empty') }, fixture.deps);
  assert.equal(result.readyForConstruction, true);
  assert.equal(result.repositories.eligibleCount, 2);
  assert.equal(result.repositories.selectedCount, 0);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup re-entry blocks if an accepted stable repository identity disappears', async () => {
  const fixture = dependencies({
    repositories: [repository(1)],
    initialState: persistedState({ selected: [{ id: 1, fullName: 'owner/repo-0', private: false }] }),
  });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-missing-accepted') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.match(result.blocker, /accepted repositories are unavailable/u);
  assert.equal(fixture.calls.prerequisite, 0);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup identity drift requires explicit repository selection before authority is rebound', async () => {
  const fixture = dependencies({
    identity: { id: 42, login: 'current-owner' },
    repositories: [repository(0, { full_name: 'current-owner/repo-0' })],
    initialState: persistedState({
      identity: { id: 41, login: 'previous-owner' },
      selected: [{ id: 1, fullName: 'previous-owner/repo-0', private: false }],
    }),
  });
  const blocked = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-identity-drift') }, fixture.deps);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.blocker, /GitHub setup identity changed/u);
  assert.equal(fixture.calls.prerequisite, 0);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);

  const rebound = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'db-setup-identity-drift'),
    requestedRepositories: ['current-owner/repo-0'],
  }, fixture.deps);
  assert.equal(rebound.readyForConstruction, true);
  assert.equal(rebound.repositories.selectedCount, 1);
  assert.equal(fixture.store.value().identity.id, 42);
  assert.equal(fixture.calls.prerequisite, 1);
  assert.equal(fixture.calls.lifecycleAuthority, 0);
  assert.equal(fixture.calls.canaryRun, 0);
});
