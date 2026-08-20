import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVEnvironmentBridge } from '../src/runtime/providers/hyperv-environment-bridge.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const location = { reference: 'db-env-local-reference', proof: 'local-ownership-proof' };
const frame = { protocol: 'devbridge/environment-bridge-v1', request: '1'.repeat(32), target, kind: 'health', body: {} };
const reply = { protocol: frame.protocol, request: frame.request, target, kind: 'health', ok: true, body: { version: '1.0.0', features: ['health', 'execute', 'observe', 'cancel', 'put', 'get'] } };

function decode(request) { return Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le'); }
function success(stdout) { return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' }; }
const locate = async (receivedTarget) => { assert.equal(receivedTarget, target); return location; };

test('Windows attachment uses only fixed PowerShell Direct mechanics for the exact located target', async () => {
  const calls = [];
  const invoke = async (request) => {
    calls.push(request);
    const script = decode(request);
    const input = JSON.parse(request.input);
    assert.equal(request.executable, 'powershell.exe');
    assert.equal(input.reference, location.reference);
    assert.equal(input.proof, location.proof);
    assert.equal(input.username, 'guest-user');
    assert.equal(input.password, 'guest-password');
    assert.equal(input.target, target);
    assert.equal(Buffer.from(input.frame, 'base64').toString('utf8'), JSON.stringify(frame));
    assert.match(script, /New-PSSession -VMName/u);
    assert.match(script, /node\.exe/u);
    assert.match(script, /bridge-agent\.mjs/u);
    assert.doesNotMatch(script, /guest-user|guest-password|env-aaaaaaaa/u);
    return success(JSON.stringify(reply));
  };
  const adapter = new HyperVEnvironmentBridge({ invoke, locate, access: async () => ({ family: 'windows', username: 'guest-user', password: 'guest-password' }) });
  assert.deepEqual(await adapter.exchange(frame), reply);
  assert.equal(calls.length, 1);
});

test('Linux attachment verifies located ownership then uses pinned noninteractive SSH with fixed helper entry point', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-bridge-'));
  const key = path.join(root, 'id');
  const known = path.join(root, 'known');
  await writeFile(key, 'private-key-placeholder');
  await writeFile(known, 'host key placeholder');
  const calls = [];
  try {
    const invoke = async (request) => {
      calls.push(request);
      if (request.executable === 'powershell.exe') {
        const input = JSON.parse(request.input);
        assert.equal(input.reference, location.reference);
        assert.equal(input.proof, location.proof);
        assert.match(decode(request), /Get-VM -Name/u);
        return success(JSON.stringify({ ready: true }));
      }
      assert.equal(request.executable, 'ssh.exe');
      assert.equal(request.input, JSON.stringify(frame));
      assert.deepEqual(request.arguments.slice(0, 3), ['-F', 'NUL', '-T']);
      assert.ok(request.arguments.includes('BatchMode=yes'));
      assert.ok(request.arguments.includes('StrictHostKeyChecking=yes'));
      assert.ok(request.arguments.includes(`UserKnownHostsFile=${known}`));
      assert.ok(request.arguments.includes('GlobalKnownHostsFile=NUL'));
      assert.ok(request.arguments.includes('IdentitiesOnly=yes'));
      assert.ok(request.arguments.includes('ForwardAgent=no'));
      assert.ok(request.arguments.includes('ClearAllForwardings=yes'));
      assert.ok(request.arguments.includes('PasswordAuthentication=no'));
      assert.deepEqual(request.arguments.slice(-4), ['guest@127.0.0.1', 'node', '/usr/local/libexec/devbridge/bridge-agent.mjs', '--exchange-stdin']);
      return success(JSON.stringify(reply));
    };
    const adapter = new HyperVEnvironmentBridge({
      invoke, locate,
      access: async () => ({ family: 'linux', user: 'guest', address: '127.0.0.1', identityFile: key, knownHostsFile: known }),
    });
    assert.deepEqual(await adapter.exchange(frame), reply);
    assert.equal(calls.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment rejects unbounded or option-shaped local access before a guest command is attempted', async () => {
  let calls = 0;
  const adapter = new HyperVEnvironmentBridge({
    locate,
    invoke: async () => { calls += 1; throw new Error('must not invoke'); },
    access: async () => ({ family: 'linux', user: '-oProxyCommand=x', address: '127.0.0.1', identityFile: 'x', knownHostsFile: 'y' }),
  });
  await assert.rejects(() => adapter.exchange(frame), /access\.user is invalid/u);
  assert.equal(calls, 0);
});

test('attachment treats location data as an injected local contract rather than deriving another module identity', async () => {
  let calls = 0;
  const adapter = new HyperVEnvironmentBridge({
    invoke: async () => { calls += 1; throw new Error('must not invoke'); },
    access: async () => ({ family: 'windows', username: 'guest', password: 'secret' }),
    locate: async () => ({ reference: '-option-shaped', proof: 'proof' }),
  });
  await assert.rejects(() => adapter.exchange(frame), /location\.reference is invalid/u);
  assert.equal(calls, 0);
});
