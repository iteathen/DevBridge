import test from 'node:test';
import assert from 'node:assert/strict';
import { UbuntuProductionImageQualification } from '../src/runtime/image-builders/ubuntu-production-qualification.js';

const target = 'subject-0123456789abcdef0123456789abcdef';
const snapshot = '20260823T100000Z';
const expected = {
  payloadGeneration: 'guest-payload-v7',
  files: [
    { path: '/usr/local/libexec/devbridge/bridge-agent.mjs', sha256: '1'.repeat(64) },
    { path: '/usr/local/libexec/devbridge/network-seed-agent.mjs', sha256: '2'.repeat(64) },
  ],
  packageGeneration: 'ubuntu-tools-v4',
  packageSnapshot: snapshot,
  packages: [
    { name: 'nodejs', version: '22.16.0+dfsg-1' },
    { name: 'cmake', version: '3.31.6-1' },
    { name: 'git', version: '1:2.48.1-0ubuntu1' },
    { name: 'openssh-server', version: '1:9.9p1-3ubuntu3' },
  ],
  commands: ['hv_fcopy_uio_daemon'],
  services: ['hv-fcopy-daemon.service'],
  capabilities: ['hyperv-fcopy-uio-v1'],
};

function bridgeResponse(frame, body) {
  return { protocol: 'devbridge/environment-bridge-v1', request: frame.request, target: frame.target, kind: frame.kind, ok: true, body };
}

function completion(stdout, { exitCode = 0, stderr = '' } = {}) {
  return {
    state: 'completed',
    reason: null,
    result: {
      exitCode,
      signal: null,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
      stdout: Buffer.from(stdout, 'utf8').toString('base64'),
      stderr: Buffer.from(stderr, 'utf8').toString('base64'),
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:00:01.000Z',
      lastOutputAt: '2026-08-23T00:00:01.000Z',
    },
  };
}

function successEvidence(overrides = {}) {
  const values = {
    protocol: 'devbridge/ubuntu-production-qualification-v1',
    os: '26.04',
    node: 'v22.16.0',
    npm: '10.9.2',
    git: 'git version 2.48.1',
    cmake: 'cmake version 3.31.6',
    compiler: 'cc (Ubuntu 14.2.0) 14.2.0',
    'payload-generation': 'guest-payload-v7',
    'package-generation': 'ubuntu-tools-v4',
    'package-snapshot': snapshot,
    network: 'ready',
    'cmake-ctest': 'passed',
    ...overrides,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function successfulBridge(calls) {
  const states = new Map();
  return {
    async exchange(frame) {
      calls.push(frame);
      if (frame.kind === 'execute') {
        const script = frame.body.arguments[1];
        assert.match(script, /dpkg-query -W/u);
        assert.match(script, /22\.16\.0\+dfsg-1/u);
        assert.match(script, /openssh-server/u);
        assert.match(script, new RegExp(`apt-get --snapshot '${snapshot}' --simulate install`, 'u'));
        assert.match(script, /sha256sum -c/u);
        assert.match(script, /hv_fcopy_uio_daemon/u);
        assert.match(script, /systemctl is-enabled --quiet/u);
        assert.match(script, /systemctl is-active --quiet/u);
        assert.match(script, /hv-fcopy-daemon\.service/u);
        assert.match(script, /eb765408-105f-49b6-b4aa-c123b64d17d4/u);
        assert.match(script, /uio_hv_generic/u);
        assert.match(script, /\/etc\/systemd\/system\/hv-fcopy-daemon\.service/u);
        assert.match(script, /cmake -S/u);
        assert.match(script, /ctest --test-dir/u);
        assert.match(script, /curl --fail/u);
        states.set(frame.request, 0);
        return bridgeResponse(frame, { state: 'running', result: null, reason: null });
      }
      const count = (states.get(frame.request) ?? 0) + 1;
      states.set(frame.request, count);
      return bridgeResponse(frame, count < 2 ? { state: 'running', result: null, reason: null } : completion(successEvidence()));
    },
  };
}

test('Ubuntu production probe proves exact files/packages/snapshot/network/build without destroying access', async () => {
  const calls = [];
  let finalized = 0;
  const qualifier = new UbuntuProductionImageQualification({
    bridge: successfulBridge(calls),
    finalizer: { async finalize() { finalized += 1; return { finalized: true }; } },
    sleep: async () => {},
    pollMs: 10,
  });
  const result = await qualifier.probe({ target, expected });
  assert.equal(result.os, '26.04');
  assert.equal(result.payloadGeneration, 'guest-payload-v7');
  assert.equal(result.packageGeneration, 'ubuntu-tools-v4');
  assert.equal(result.packageSnapshot, snapshot);
  assert.deepEqual(result.commands, ['hv_fcopy_uio_daemon']);
  assert.deepEqual(result.services, ['hv-fcopy-daemon.service']);
  assert.deepEqual(result.capabilities, ['hyperv-fcopy-uio-v1']);
  assert.equal(result.network, true);
  assert.equal(result.cmakeCtest, true);
  assert.equal(result.sanitized, false);
  assert.equal(finalized, 0);
  assert.equal(calls.filter((entry) => entry.kind === 'execute').length, 1);
});

test('Ubuntu production qualification finalizes only after successful probe', async () => {
  const calls = [];
  let finalized = 0;
  const qualifier = new UbuntuProductionImageQualification({
    bridge: successfulBridge(calls),
    finalizer: { async finalize(selected) { finalized += 1; assert.equal(selected, target); return { finalized: true }; } },
    sleep: async () => {},
    pollMs: 10,
  });
  const result = await qualifier.qualify({ target, expected });
  assert.equal(result.sanitized, true);
  assert.equal(result.packageSnapshot, snapshot);
  assert.equal(finalized, 1);
});

test('Ubuntu production qualification never finalizes a failed functional probe', async () => {
  let finalized = 0;
  const bridge = {
    async exchange(frame) {
      return bridgeResponse(frame, completion('', { exitCode: 1, stderr: 'compile probe failed' }));
    },
  };
  const qualifier = new UbuntuProductionImageQualification({
    bridge,
    finalizer: { async finalize() { finalized += 1; return { finalized: true }; } },
  });
  await assert.rejects(() => qualifier.qualify({ target, expected }), /compile probe failed/u);
  assert.equal(finalized, 0);
});

test('Ubuntu production qualification rejects mutable authority before guest effects', async () => {
  let effects = 0;
  const qualifier = new UbuntuProductionImageQualification({
    bridge: { async exchange() { effects += 1; } },
    finalizer: { async finalize() { effects += 1; } },
  });
  await assert.rejects(() => qualifier.probe({
    target,
    expected: { ...expected, packages: [{ name: 'nodejs', version: 'latest' }] },
  }), /version is invalid/u);
  await assert.rejects(() => qualifier.probe({
    target,
    expected: { ...expected, packageSnapshot: 'latest' },
  }), /package snapshot is invalid/u);
  await assert.rejects(() => qualifier.probe({
    target,
    expected: { ...expected, services: ['../hv-fcopy-daemon.service'] },
  }), /service 0 is invalid/u);
  await assert.rejects(() => qualifier.probe({
    target,
    expected: { ...expected, capabilities: ['future-capability-v1'] },
  }), /capability 0 is unsupported/u);
  assert.equal(effects, 0);
});

test('Ubuntu production qualification rejects observed snapshot drift before finalization', async () => {
  let finalized = 0;
  const bridge = {
    async exchange(frame) {
      return bridgeResponse(frame, completion(successEvidence({ 'package-snapshot': '20260824T100000Z' })));
    },
  };
  const qualifier = new UbuntuProductionImageQualification({
    bridge,
    finalizer: { async finalize() { finalized += 1; return { finalized: true }; } },
  });
  await assert.rejects(() => qualifier.qualify({ target, expected }), /does not match the required image contract/u);
  assert.equal(finalized, 0);
});

test('Ubuntu production qualification requires finalization completion evidence', async () => {
  const bridge = { async exchange(frame) { return bridgeResponse(frame, completion(successEvidence())); } };
  const qualifier = new UbuntuProductionImageQualification({
    bridge,
    finalizer: { async finalize() { return { finalized: false }; } },
  });
  await assert.rejects(() => qualifier.finalize(target), /finalization did not report completion/u);
});
