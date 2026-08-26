import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import { requestWindowsLifecycleAuthorityElevation } from '../src/setup/windows-lifecycle-authority-elevation.js';
import { parseSetupCommandOptions } from '../src/setup/command-options.js';
import {
  classifyWindowsLifecycleAuthorityLegacyService,
  classifyWindowsLifecycleAuthorityRuntimeLayout,
  reconcileWindowsLifecycleAuthorityLegacyRuntime,
} from '../src/setup/windows-lifecycle-authority-legacy-runtime-migration.js';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../src/setup/windows-lifecycle-authority-readiness.js';
import { runWindowsLifecycleAuthoritySetupChild } from '../src/app/windows-lifecycle-authority-setup-child.js';

const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const PLAN = Object.freeze({
  stateDirectory: STATE,
  ownershipManifest: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\owner\\ownership.json',
  endpoints: Object.freeze({ mutation: Object.freeze({ endpoint: '\\\\.\\pipe\\devbridge-environment-owner-mutation-v1' }) }),
});

function serviceResult({ ready, service = 'ready', protectedState = 'ready', authorityIdentity = 'a'.repeat(32), blocker = null, changed = false } = {}) {
  return Object.freeze({
    protocol: 'devbridge/windows-lifecycle-authority-service-v1',
    platform: 'win32',
    ready,
    blocker,
    changed,
    authorityIdentity,
    service,
    protectedState,
  });
}

function unavailable() {
  return serviceResult({
    ready: false,
    service: 'unavailable',
    protectedState: 'unknown',
    blocker: 'bounded elevation required',
  });
}

function host(elevated) {
  return Object.freeze({ elevated, operatorSid: 'S-1-5-21-1-2-3-1001', programData: 'C:\\ProgramData' });
}

async function elevationChannel(root) {
  const entries = await readdir(path.join(root, 'state'));
  assert.equal(entries.length, 1);
  const directory = path.join(root, 'state', entries[0]);
  return Object.freeze({
    inputFile: path.join(directory, 'input.json'),
    resultFile: path.join(directory, 'result.json'),
  });
}

function readinessDeps({ elevated = false, serviceReconciler, legacyRuntimeMigration = async () => ({ ready: true }) } = {}) {
  return {
    migrationSafety: async () => ({ ready: true }),
    legacyRuntimeMigration,
    inspectHost: async () => host(elevated),
    clientFactory: () => Object.freeze({ inspect: async () => ({ protocol: 'devbridge/environment-operator-v1' }) }),
    verifyService: async () => ({ ready: true }),
    verifyProtection: async () => ({ ready: true }),
    serviceReconciler,
  };
}

test('exact-current ordinary readiness performs zero elevation', async () => {
  let elevations = 0;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    requestElevation: async () => { elevations += 1; return { completed: true }; },
  }, readinessDeps({
    serviceReconciler: async (_options, dependencies) => {
      await dependencies.inspectHost({});
      await dependencies.probe(PLAN);
      return serviceResult({ ready: true });
    },
  }));
  assert.equal(result.ready, true);
  assert.equal(elevations, 0);
});

test('ordinary stale authority uses one elevation and resumes ordinary proof in the same readiness invocation', async () => {
  let services = 0;
  let elevations = 0;
  let probes = 0;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    requestElevation: async () => { elevations += 1; return { completed: true, exitCode: 0 }; },
  }, readinessDeps({
    serviceReconciler: async (_options, dependencies) => {
      services += 1;
      await dependencies.inspectHost({});
      if (services === 1) return unavailable();
      await dependencies.probe(PLAN);
      probes += 1;
      return serviceResult({ ready: true, changed: true });
    },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(services, 2);
  assert.equal(elevations, 1);
  assert.equal(probes, 1);
});

test('UAC refusal stops after one attempt and does not repeat service reconciliation', async () => {
  let services = 0;
  let elevations = 0;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    requestElevation: async () => {
      elevations += 1;
      return { completed: false, blocker: 'cancelled once' };
    },
  }, readinessDeps({
    serviceReconciler: async (_options, dependencies) => {
      services += 1;
      await dependencies.inspectHost({});
      return unavailable();
    },
  }));
  assert.equal(result.ready, false);
  assert.equal(result.blocker, 'cancelled once');
  assert.equal(services, 1);
  assert.equal(elevations, 1);
});

test('post-child uncertainty never causes a second elevation in the same readiness invocation', async () => {
  let services = 0;
  let elevations = 0;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    requestElevation: async () => { elevations += 1; return { completed: true }; },
  }, readinessDeps({
    serviceReconciler: async (_options, dependencies) => {
      services += 1;
      await dependencies.inspectHost({});
      return unavailable();
    },
  }));
  assert.equal(result.ready, false);
  assert.equal(services, 2);
  assert.equal(elevations, 1);
});

test('elevated child migrates qualifying legacy runtime before service reconciliation and returns structural success', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    mode: 'elevated-child',
  }, readinessDeps({
    elevated: true,
    legacyRuntimeMigration: async () => { calls.push('legacy'); return { ready: true, required: true, changed: true }; },
    serviceReconciler: async (_options, dependencies) => {
      calls.push('service');
      await dependencies.inspectHost({});
      await dependencies.probe(PLAN);
      return serviceResult({ ready: true, changed: true });
    },
  }));
  assert.equal(result.ready, true);
  assert.deepEqual(calls, ['legacy', 'service']);
});

test('non-qualifying legacy runtime stops the elevated child before service mutation', async () => {
  let serviceCalled = false;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    mode: 'elevated-child',
  }, readinessDeps({
    elevated: true,
    legacyRuntimeMigration: async () => ({ ready: false, blocker: 'legacy mismatch' }),
    serviceReconciler: async () => { serviceCalled = true; return serviceResult({ ready: true }); },
  }));
  assert.equal(result.ready, false);
  assert.equal(result.blocker, 'legacy mismatch');
  assert.equal(serviceCalled, false);
});

test('empty generation container does not suppress exact fixed-runtime migration', () => {
  assert.equal(classifyWindowsLifecycleAuthorityRuntimeLayout({
    generationsExist: true,
    journalPresent: false,
    mode: 'fixed-running',
    generationVerified: false,
  }), 'legacy');
});

test('only an exact verified generation-addressed service suppresses legacy migration', () => {
  assert.equal(classifyWindowsLifecycleAuthorityRuntimeLayout({
    generationsExist: true,
    journalPresent: false,
    mode: 'generation-running',
    generationVerified: true,
  }), 'generation');
  assert.throws(() => classifyWindowsLifecycleAuthorityRuntimeLayout({
    generationsExist: true,
    journalPresent: false,
    mode: 'generation-running',
    generationVerified: false,
  }), /generation-addressed protected runtime evidence is incomplete/u);
});

test('fixed legacy service may omit its historically absent description without weakening generation identity', () => {
  const fixed = Object.freeze({
    serviceCommand: 'fixed-command',
    service: Object.freeze({ account: 'NT SERVICE\\DevBridgeLifecycle-test', description: 'fixed-description' }),
  });
  const generation = Object.freeze({
    serviceCommand: 'generation-command',
    service: Object.freeze({ account: fixed.service.account, description: 'generation-description' }),
  });
  const observed = Object.freeze({
    exists: true,
    state: 'Running',
    startName: fixed.service.account,
    pathName: fixed.serviceCommand,
    description: '',
  });
  assert.equal(classifyWindowsLifecycleAuthorityLegacyService(observed, fixed, generation), 'fixed-running');
  assert.equal(classifyWindowsLifecycleAuthorityLegacyService(Object.freeze({
    ...observed,
    pathName: generation.serviceCommand,
  }), fixed, generation), 'foreign');
  assert.equal(classifyWindowsLifecycleAuthorityLegacyService(Object.freeze({
    ...observed,
    pathName: generation.serviceCommand,
    description: generation.service.description,
  }), fixed, generation), 'generation-running');
});

test('legacy migration observes each durable frontier before repeating an effect', async () => {
  const calls = [];
  const state = { staged: false, mode: 'fixed-running' };
  const mechanics = Object.freeze({
    notRequired: false,
    generation: 'b'.repeat(64),
    observe: async () => ({ ...state }),
    checkpoint: async (record) => { calls.push(['checkpoint', record]); },
    stage: async () => { calls.push(['stage']); state.staged = true; return true; },
    quiesce: async () => { calls.push(['quiesce']); state.mode = 'fixed-stopped'; return true; },
    promote: async () => { calls.push(['promote']); state.mode = 'generation-stopped'; return true; },
    start: async () => { calls.push(['start']); state.mode = 'generation-running'; return true; },
    health: async () => { calls.push(['health']); return true; },
    restore: async () => { calls.push(['restore']); return true; },
  });
  const result = await reconcileWindowsLifecycleAuthorityLegacyRuntime({ platform: 'win32' }, {
    createMechanics: async () => mechanics,
  });
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.deepEqual(calls.filter((entry) => entry[0] !== 'checkpoint').map((entry) => entry[0]), ['stage', 'quiesce', 'promote', 'start', 'health']);
  for (const effect of ['stage', 'quiesce', 'promote', 'start']) {
    const planned = calls.findIndex((entry) => entry[0] === 'checkpoint' && entry[1].effect === effect && entry[1].state === 'planned');
    const attempted = calls.findIndex((entry) => entry[0] === 'checkpoint' && entry[1].effect === effect && entry[1].state === 'attempted');
    const executed = calls.findIndex((entry) => entry[0] === effect);
    assert.ok(planned >= 0 && planned < attempted && attempted < executed, `${effect} must checkpoint before execution`);
  }
});

test('legacy migration resumes after promotion without replaying stage, quiesce, or promote', async () => {
  const calls = [];
  const state = { staged: true, mode: 'generation-stopped' };
  const mechanics = Object.freeze({
    notRequired: false,
    generation: 'c'.repeat(64),
    observe: async () => ({ ...state }),
    checkpoint: async () => {},
    stage: async () => { calls.push('stage'); return false; },
    quiesce: async () => { calls.push('quiesce'); return false; },
    promote: async () => { calls.push('promote'); return false; },
    start: async () => { calls.push('start'); state.mode = 'generation-running'; return true; },
    health: async () => { calls.push('health'); return true; },
    restore: async () => { calls.push('restore'); return true; },
  });
  const result = await reconcileWindowsLifecycleAuthorityLegacyRuntime({ platform: 'win32' }, { createMechanics: async () => mechanics });
  assert.equal(result.ready, true);
  assert.deepEqual(calls, ['start', 'health']);
});

test('legacy generation health failure restores the exact fixed authority and remains blocked', async () => {
  const calls = [];
  const mechanics = Object.freeze({
    notRequired: false,
    generation: 'd'.repeat(64),
    observe: async () => ({ staged: true, mode: 'generation-running' }),
    checkpoint: async () => {},
    stage: async () => false,
    quiesce: async () => false,
    promote: async () => false,
    start: async () => false,
    health: async () => false,
    restore: async () => { calls.push('restore'); return true; },
  });
  const result = await reconcileWindowsLifecycleAuthorityLegacyRuntime({ platform: 'win32' }, { createMechanics: async () => mechanics });
  assert.equal(result.ready, false);
  assert.deepEqual(calls, ['restore']);
});

test('legacy mechanics admission failure is fail-closed and never becomes generic migration authority', async () => {
  const result = await reconcileWindowsLifecycleAuthorityLegacyRuntime({ platform: 'win32' }, {
    createMechanics: async () => { throw new Error('foreign service path'); },
  });
  assert.equal(result.ready, false);
  assert.match(result.blocker, /will not seize or rewrite/u);
});

test('elevation adapter accepts only a managed entry launcher and returns bounded child status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-elevation-'));
  try {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await mkdir(path.join(root, 'state'));
    const launcher = path.join(bin, 'devbridge-entry.mjs');
    const node = path.join(root, 'node.exe');
    await writeFile(launcher, 'export {};\n');
    await writeFile(node, 'node');
    let invoked = 0;
    const runnerHead = 'a'.repeat(40);
    const result = await requestWindowsLifecycleAuthorityElevation({
      home: root,
      launcher,
      nodeExecutable: node,
      platform: 'win32',
      invoke: async (request) => {
        invoked += 1;
        assert.equal(request.executable, 'powershell.exe');
        assert.equal(request.timeoutMs, 5 * 60_000);
        const outer = JSON.parse(request.input);
        assert.equal(typeof outer.brokerCommand, 'string');
        assert.ok(outer.brokerCommand.length > 0);
        const channel = await elevationChannel(root);
        const input = JSON.parse(await readFile(channel.inputFile, 'utf8'));
        const { resultFile } = channel;
        assert.equal(input.home, path.resolve(root));
        assert.equal(input.launcher, path.resolve(launcher));
        assert.equal(input.node, path.resolve(node));
        assert.equal(input.runnerHead, runnerHead);
        await writeFile(resultFile, `${JSON.stringify({
          protocol: 'devbridge/windows-lifecycle-authority-elevation-broker-v1',
          requestedHead: runnerHead,
          started: true,
          exitCode: 0,
          stdout: JSON.stringify({
            protocol: 'devbridge/windows-lifecycle-authority-elevated-child-v1',
            ready: true,
            changed: true,
            service: 'ready',
            protectedState: 'ready',
            blocker: null,
          }),
          stderr: '',
          error: null,
          outputTruncated: false,
        })}\n`);
        return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"started":true,"exitCode":0}' };
      },
    }, {
      resolveRunnerHead: async () => runnerHead,
    });
    assert.equal(invoked, 1);
    assert.equal(result.completed, true);
    assert.equal(result.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rendered elevation broker reads its bounded input and returns exact child evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-elevation-'));
  try {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await mkdir(path.join(root, 'state'));
    const launcher = path.join(bin, 'devbridge-entry.mjs');
    const runnerHead = 'd'.repeat(40);
    await writeFile(launcher, `process.stdout.write(JSON.stringify({
      protocol: 'devbridge/windows-lifecycle-authority-elevated-child-v1',
      ready: true,
      changed: false,
      service: 'ready',
      protectedState: 'ready',
      blocker: null,
    }));\n`);
    const result = await requestWindowsLifecycleAuthorityElevation({
      home: root,
      launcher,
      nodeExecutable: process.execPath,
      platform: 'win32',
      invoke: async (request) => {
        const outer = JSON.parse(request.input);
        const broker = await invokeCommand({
          executable: 'powershell.exe',
          arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', outer.brokerCommand],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
          environment: process.env,
        });
        return {
          ...broker,
          exitCode: 0,
          stdout: JSON.stringify({ started: true, exitCode: broker.exitCode }),
        };
      },
    }, {
      resolveRunnerHead: async () => runnerHead,
    });
    assert.equal(result.completed, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(await readdir(path.join(root, 'state')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('elevation adapter returns the bounded child blocker and cleans its result channel', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-elevation-'));
  try {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await mkdir(path.join(root, 'state'));
    const launcher = path.join(bin, 'devbridge-entry.mjs');
    const node = path.join(root, 'node.exe');
    await writeFile(launcher, 'export {};\n');
    await writeFile(node, 'node');
    let resultDirectory = null;
    const result = await requestWindowsLifecycleAuthorityElevation({
      home: root,
      launcher,
      nodeExecutable: node,
      platform: 'win32',
      invoke: async (request) => {
        const outer = JSON.parse(request.input);
        assert.equal(typeof outer.brokerCommand, 'string');
        assert.ok(outer.brokerCommand.length > 0);
        const channel = await elevationChannel(root);
        const input = JSON.parse(await readFile(channel.inputFile, 'utf8'));
        const { resultFile } = channel;
        resultDirectory = path.dirname(resultFile);
        assert.equal(input.runnerHead, 'b'.repeat(40));
        await writeFile(resultFile, `${JSON.stringify({
          protocol: 'devbridge/windows-lifecycle-authority-elevation-broker-v1',
          requestedHead: 'b'.repeat(40),
          started: true,
          exitCode: 3,
          stdout: JSON.stringify({
            protocol: 'devbridge/windows-lifecycle-authority-elevated-child-v1',
            ready: false,
            changed: false,
            service: 'blocked',
            protectedState: 'unknown',
            blocker: 'exact protected blocker',
          }),
          stderr: '',
          error: null,
          outputTruncated: false,
        })}\n`);
        return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"started":true,"exitCode":3}' };
      },
    }, {
      resolveRunnerHead: async () => 'b'.repeat(40),
    });
    assert.equal(result.completed, false);
    assert.equal(result.exitCode, 3);
    assert.match(result.blocker, /exact protected blocker/u);
    await assert.rejects(lstat(resultDirectory), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('elevation adapter returns a bounded broker error when the lifecycle child never starts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-elevation-'));
  try {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await mkdir(path.join(root, 'state'));
    const launcher = path.join(bin, 'devbridge-entry.mjs');
    const node = path.join(root, 'node.exe');
    await writeFile(launcher, 'export {};\n');
    await writeFile(node, 'node');
    const runnerHead = 'c'.repeat(40);
    const result = await requestWindowsLifecycleAuthorityElevation({
      home: root,
      launcher,
      nodeExecutable: node,
      platform: 'win32',
      invoke: async (request) => {
        const outer = JSON.parse(request.input);
        assert.equal(typeof outer.brokerCommand, 'string');
        assert.ok(outer.brokerCommand.length > 0);
        const channel = await elevationChannel(root);
        const input = JSON.parse(await readFile(channel.inputFile, 'utf8'));
        const { resultFile } = channel;
        assert.equal(input.runnerHead, runnerHead);
        await writeFile(resultFile, `${JSON.stringify({
          protocol: 'devbridge/windows-lifecycle-authority-elevation-broker-v1',
          requestedHead: runnerHead,
          started: false,
          exitCode: 1,
          stdout: '',
          stderr: '',
          error: 'exact launcher startup failure',
          outputTruncated: false,
        })}\n`);
        return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"started":true,"exitCode":1}' };
      },
    }, {
      resolveRunnerHead: async () => runnerHead,
    });
    assert.equal(result.completed, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.blocker, /exact launcher startup failure/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('elevation adapter fails before UAC when the current runner identity is not exact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-elevation-'));
  try {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const launcher = path.join(bin, 'devbridge-entry.mjs');
    const node = path.join(root, 'node.exe');
    await writeFile(launcher, 'export {};\n');
    await writeFile(node, 'node');
    let invoked = false;
    const result = await requestWindowsLifecycleAuthorityElevation({
      home: root,
      launcher,
      nodeExecutable: node,
      platform: 'win32',
      invoke: async () => { invoked = true; return null; },
    }, {
      resolveRunnerHead: async () => 'cuda-target',
    });
    assert.equal(invoked, false);
    assert.equal(result.attempted, false);
    assert.equal(result.completed, false);
    assert.match(result.blocker, /exact current DevBridge runner identity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('elevation adapter rejects arbitrary launcher paths before UAC', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-elevation-'));
  try {
    const launcher = path.join(root, 'arbitrary.mjs');
    const node = path.join(root, 'node.exe');
    await writeFile(launcher, 'export {};\n');
    await writeFile(node, 'node');
    let invoked = false;
    await assert.rejects(
      requestWindowsLifecycleAuthorityElevation({
        home: root,
        launcher,
        nodeExecutable: node,
        platform: 'win32',
        invoke: async () => { invoked = true; return null; },
      }),
      /managed DevBridge entry boundary/u,
    );
    assert.equal(invoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('elevated child entry requires the parent marker and accepts no construction authority', async () => {
  await assert.rejects(
    runWindowsLifecycleAuthoritySetupChild({ env: { DEVBRIDGE_HOME: 'C:\\Users\\Operator\\.devbridge' } }, { platform: 'win32' }),
    /bounded UAC parent contract/u,
  );
  let request = null;
  const result = await runWindowsLifecycleAuthoritySetupChild({
    env: {
      DEVBRIDGE_HOME: 'C:\\Users\\Operator\\.devbridge',
      DEVBRIDGE_LIFECYCLE_AUTHORITY_ELEVATED_CHILD: '1',
    },
  }, {
    platform: 'win32',
    homeDirectory: 'C:\\Users\\Operator',
    invoke: async () => {},
    reconciler: async (value) => {
      request = value;
      return { ready: true, changed: true, service: 'ready', protectedState: 'ready' };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(request.mode, 'elevated-child');
  assert.equal(request.requestElevation, null);
  assert.equal(Object.hasOwn(request, 'construct'), false);
});

test('lifecycle child admits only an exact entry-injected broker home', () => {
  const authorityHome = 'C:\\Users\\Operator\\.devbridge';
  const selected = parseSetupCommandOptions([
    '--lifecycle-authority-child',
    '--no-update',
    '--home',
    'c:\\users\\operator\\.devbridge',
  ], { authorityHome, platform: 'win32' });
  assert.equal(selected.home, 'c:\\users\\operator\\.devbridge');
  assert.equal(selected.lifecycleAuthorityChild, true);
  assert.equal(selected.entryNoUpdate, true);

  assert.throws(() => parseSetupCommandOptions([
    '--lifecycle-authority-child', '--no-update', '--home', 'C:\\Users\\Other\\.devbridge',
  ], { authorityHome, platform: 'win32' }), /exact broker-bound setup home/u);
  for (const capability of [
    ['--construct'],
    ['--track-ref', 'main'],
    ['--repository', 'owner/repository'],
  ]) {
    assert.throws(() => parseSetupCommandOptions([
      '--lifecycle-authority-child', '--no-update', ...capability,
    ], { authorityHome, platform: 'win32' }), /accepts no setup capability arguments/u);
  }
});
