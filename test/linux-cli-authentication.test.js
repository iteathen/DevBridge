import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  attemptLinuxCliAuthentication,
  LOCAL_AUTHENTICATION_ATTEMPT_PROTOCOL,
  LOCAL_AUTHENTICATION_OBSERVATION_PROTOCOL,
  observeLinuxCliAuthentication,
} from '../src/setup/linux-cli-authentication.js';

const IDENTITY = 'a'.repeat(64);
const LAUNCH_IDENTITY = 'b'.repeat(64);
const SUBJECT = Object.freeze({ operation: 'refresh', evidence: Object.freeze({ digest: 'c'.repeat(64) }) });

function observation(overrides = {}) {
  return Object.freeze({
    protocol: LOCAL_AUTHENTICATION_OBSERVATION_PROTOCOL,
    platform: 'linux',
    applicable: true,
    ready: true,
    identity: IDENTITY,
    reason: null,
    ...overrides,
  });
}

function invocation(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function ports(overrides = {}) {
  return {
    observe: async () => observation(),
    observeLaunch: async () => ({ identity: LAUNCH_IDENTITY }),
    invoke: async () => invocation(),
    readTerminalType: async () => 'xterm-256color',
    ...overrides,
  };
}

test('authentication observation is read-only, bounded, and platform-specific', async () => {
  assert.deepEqual(await observeLinuxCliAuthentication({}, {
    readPlatform: async () => 'linux',
    inspect: async () => ({ identity: IDENTITY }),
  }), observation());
  assert.deepEqual(await observeLinuxCliAuthentication({}, { readPlatform: async () => 'win32' }), {
    protocol: LOCAL_AUTHENTICATION_OBSERVATION_PROTOCOL,
    platform: 'other',
    applicable: false,
    ready: false,
    identity: null,
    reason: 'not-applicable',
  });
  assert.equal((await observeLinuxCliAuthentication({}, {
    readPlatform: async () => { throw new Error('/private/platform'); },
  })).reason, 'platform-unavailable');
  assert.equal((await observeLinuxCliAuthentication({}, {
    readPlatform: async () => 'linux',
    inspect: async () => { throw new Error('/private/program'); },
  })).reason, 'program-unavailable');
});

test('authentication attempt fixes executable, arguments, input, bounds, and non-secret environment', async () => {
  let request = null;
  const result = await attemptLinuxCliAuthentication({ subject: SUBJECT }, ports({
    invoke: async (value) => { request = value; return invocation({ stdout: '{"forged":"ready"}' }); },
  }));
  assert.deepEqual(result, {
    protocol: LOCAL_AUTHENTICATION_ATTEMPT_PROTOCOL,
    attempted: true,
    completed: true,
    reason: null,
  });
  assert.equal(request.executable, '/usr/bin/sudo');
  assert.equal(request.arguments[0], '--');
  assert.equal(request.arguments[1], process.execPath);
  assert.equal(path.basename(request.arguments[2]), 'linux-cli-authenticated-entry.js');
  assert.equal(request.arguments.length, 3);
  assert.equal(request.input, `${JSON.stringify(SUBJECT)}\n`);
  assert.equal(request.timeoutMs, 5 * 60_000);
  assert.equal(request.maxOutputBytes, 64 * 1024);
  assert.deepEqual(request.environment, {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', TERM: 'xterm-256color',
  });
  for (const name of ['HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'SUDO_ASKPASS']) {
    assert.equal(Object.hasOwn(request.environment, name), false, name);
  }
});

test('authentication attempt omits malformed terminal evidence', async () => {
  let request = null;
  await attemptLinuxCliAuthentication({ subject: SUBJECT }, ports({
    readTerminalType: async () => 'xterm;SECRET=/private',
    invoke: async (value) => { request = value; return invocation(); },
  }));
  assert.equal(Object.hasOwn(request.environment, 'TERM'), false);
});

test('authentication attempt refuses mutable, cyclic, symbolic, or oversized subjects before observation', async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  Object.freeze(cyclic);
  const symbolic = Object.freeze({ [Symbol('foreign')]: true });
  const hiddenArray = [];
  Object.defineProperty(hiddenArray, 'hidden', { value: true });
  Object.freeze(hiddenArray);
  const cases = [
    undefined,
    null,
    Object.freeze([]),
    { mutable: true },
    Object.freeze({ nested: { mutable: true } }),
    Object.freeze({ value: 1.5 }),
    Object.freeze({ value: 1n }),
    Object.freeze({ value: 'x'.repeat(9 * 1024) }),
    cyclic,
    symbolic,
    Object.freeze({ value: hiddenArray }),
  ];
  for (const subject of cases) {
    let observed = false;
    await assert.rejects(attemptLinuxCliAuthentication({ subject }, {
      ...ports(), observe: async () => { observed = true; return observation(); },
    }));
    assert.equal(observed, false);
  }
});

test('authentication attempt never invokes when pre-attempt evidence is unavailable', async () => {
  for (const replacement of [
    { observe: async () => observation({ ready: false, identity: null, reason: 'program-unavailable' }) },
    { observe: async () => ({ ...observation(), widened: true }) },
    { observeLaunch: async () => ({ identity: 'not-a-digest' }) },
  ]) {
    let invoked = false;
    const result = await attemptLinuxCliAuthentication({ subject: SUBJECT }, ports({
      ...replacement,
      invoke: async () => { invoked = true; return invocation(); },
    }));
    assert.equal(result.completed, false);
    assert.equal(result.attempted, false);
    assert.equal(invoked, false);
  }
});

test('authentication attempt classifies invocation failure and post-attempt drift without trusting output', async () => {
  const cases = [
    ['attempt-failed', { invoke: async () => { throw new Error('/private/path'); } }],
    ['cancelled', { invoke: async () => invocation({ exitCode: null, aborted: true }) }],
    ['timed-out', { invoke: async () => invocation({ exitCode: null, timedOut: true }) }],
    ['result-invalid', { invoke: async () => invocation({ outputTruncated: true }) }],
    ['not-completed', { invoke: async () => invocation({ exitCode: 1, stderr: 'sudo: denied' }) }],
  ];
  for (const [reason, replacement] of cases) {
    const result = await attemptLinuxCliAuthentication({ subject: SUBJECT }, ports(replacement));
    assert.equal(result.attempted, true, reason);
    assert.equal(result.completed, false, reason);
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(JSON.stringify(result).includes('sudo'), false);
  }

  let observations = 0;
  const drifted = await attemptLinuxCliAuthentication({ subject: SUBJECT }, ports({
    observe: async () => {
      observations += 1;
      return observation(observations === 1 ? {} : { identity: 'd'.repeat(64) });
    },
  }));
  assert.equal(drifted.reason, 'identity-changed');

  let launches = 0;
  const launchDrift = await attemptLinuxCliAuthentication({ subject: SUBJECT }, ports({
    observeLaunch: async () => ({ identity: (++launches === 1 ? LAUNCH_IDENTITY : 'e'.repeat(64)) }),
  }));
  assert.equal(launchDrift.reason, 'identity-changed');
});

test('authentication contracts and ports are exact', async () => {
  await assert.rejects(observeLinuxCliAuthentication({ path: '/foreign' }), /unknown field/u);
  await assert.rejects(observeLinuxCliAuthentication({}, { inspect: async () => null, fallback: async () => null }), /unknown field/u);
  await assert.rejects(attemptLinuxCliAuthentication({ subject: SUBJECT, executable: '/bin/foreign' }, ports()), /unknown field/u);
  await assert.rejects(attemptLinuxCliAuthentication({ subject: SUBJECT }, { ...ports(), fallback: async () => null }), /unknown field/u);
});

test('production Linux observation proves the fixed sudo identity without invoking it', {
  skip: process.platform !== 'linux',
}, async () => {
  const result = await observeLinuxCliAuthentication();
  assert.deepEqual(result, {
    protocol: LOCAL_AUTHENTICATION_OBSERVATION_PROTOCOL,
    platform: 'linux',
    applicable: true,
    ready: true,
    identity: result.identity,
    reason: null,
  });
  assert.match(result.identity, /^[0-9a-f]{64}$/u);
});

test('authentication adapter has one fixed CLI topology and no downstream identity leak', async () => {
  const source = (await readFile(new URL('../src/setup/linux-cli-authentication.js', import.meta.url), 'utf8')).toLowerCase();
  assert.equal(source.includes('pkexec'), false);
  assert.equal(source.includes("shell:"), false);
  assert.equal(source.includes("'-s'"), false);
  assert.equal(source.includes("'-e'"), false);
  assert.equal(source.includes("'-n'"), false);
  assert.equal(source.includes('askpass'), false);
  for (const identity of ['lifecycle-authority-refresh-child', 'provider', 'repository', 'virtual-machine', 'systemd', 'service']) {
    assert.equal(source.includes(identity), false, identity);
  }
});
