import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { HyperVEnvironmentBridge } from '../src/runtime/providers/hyperv-environment-bridge.js';
import { LINUX_BRIDGE_SESSION_COMMAND } from '../src/runtime/providers/guest-bridge-command-session.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const location = { reference: 'db-env-local-reference', proof: 'local-ownership-proof' };
const frame = { protocol: 'devbridge/environment-bridge-v1', request: '1'.repeat(32), target, kind: 'health', body: {} };
const reply = { protocol: frame.protocol, request: frame.request, target, kind: 'health', ok: true, body: { version: '1.0.0', features: ['health', 'execute', 'observe', 'cancel', 'put', 'get'] } };

function decode(request) { return Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le'); }
function success(stdout) { return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' }; }
const locate = async (receivedTarget) => { assert.equal(receivedTarget, target); return location; };

test('Linux guest session keeps fixed execution mechanics, binds its target and carries exact frame bytes', () => {
  const input = new EventEmitter(), output = [], calls = [];
  const source = Buffer.from(LINUX_BRIDGE_SESSION_COMMAND.match(/Buffer.from\("([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8');
  runInNewContext(source, { Buffer, TextDecoder,
    require(name) { assert.equal(name, 'node:child_process'); return { spawnSync(program, args, options) {
      calls.push({ program, args, options }); return { status: 0, stdout: JSON.stringify(reply), stderr: '' };
    } }; },
    process: { stdin: input, stdout: { write(value) { output.push(JSON.parse(value)); } }, env: {}, exit() { throw new Error('session closed'); } },
  });
  input.emit('data', Buffer.from(JSON.stringify({ target }) + '\n'));
  input.emit('data', Buffer.from(JSON.stringify(frame) + '\n'));
  input.emit('data', Buffer.from(JSON.stringify(frame) + '\n'));
  assert.equal(calls.length, 2);
  assert.deepEqual(output, [{ ready: true }, reply, reply]);
  assert.equal(calls[0].program, 'node');
  assert.deepEqual(Array.from(calls[0].args), ['/usr/local/libexec/devbridge/bridge-agent.mjs', '--exchange-stdin']);
  assert.equal(calls[0].options.input, JSON.stringify(frame));
  assert.equal(calls[0].options.env.DEVBRIDGE_GUEST_TARGET, target);
  assert.equal(calls[0].options.shell, false);
  assert.throws(() => input.emit('data', Buffer.from(JSON.stringify({ ...frame, target: 'env-' + 'b'.repeat(32) }) + '\n')), /session closed/);
  assert.equal(calls.length, 2);
});

test('Linux channel performs native proof once per connection and pinned SSH never receives credentials in a frame', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityFile = path.join(root, 'key'), knownHostsFile = path.join(root, 'known');
  await writeFile(identityFile, 'key'); await writeFile(knownHostsFile, 'pinned');
  let proofs = 0; const opened = [];
  const adapter = new HyperVEnvironmentBridge({ locate,
    invoke: async () => { proofs++; return success('{"ready":true}'); },
    access: async () => ({ family: 'linux', user: 'bridge', address: '10.0.0.2', identityFile, knownHostsFile }),
    openChannel(options) {
      const channel = { closed: false, requests: [], close() { this.closed = true; }, async exchange(value) {
        this.requests.push(value); return value.kind ? reply : { ready: true };
      } }; opened.push({ channel, options }); return channel;
    },
  });
  t.after(() => adapter.close());
  await adapter.exchange(frame); await adapter.exchange(frame);
  assert.equal(proofs, 1); assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].channel.requests[0], { target });
  assert.equal(opened[0].options.executable, 'ssh.exe');
  assert.equal(opened[0].options.arguments.includes('StrictHostKeyChecking=yes'), true);
  opened[0].channel.closed = true;
  await adapter.exchange(frame); assert.equal(proofs, 2); assert.equal(opened.length, 2);
});

test('bound Windows connection is reused, invalidated by authority changes, and never replays a lost frame', async () => {
  const opened = [], delivered = [];
  let secret = 'first', fail = false;
  const adapter = new HyperVEnvironmentBridge({ invoke: async () => { throw new Error('unexpected one-shot invocation'); }, locate,
    access: async () => ({ family: 'windows', username: 'guest', password: secret }),
    openChannel(options) {
      const channel = { closed: false, close() { this.closed = true; }, async exchange(value) {
        delivered.push(value);
        if (!value.kind) return { ready: true };
        if (fail) throw new Error('response lost');
        return reply;
      } };
      opened.push({ channel, options }); return channel;
    },
  });
  await adapter.exchange(frame, { binding: 'generation-one' });
  await adapter.exchange(frame, { binding: 'generation-one' });
  assert.equal(opened.length, 1);
  assert.equal(delivered.length, 3);
  assert.equal(JSON.stringify(opened[0].options).includes(secret), false);
  secret = 'rotated'; await adapter.exchange(frame, { binding: 'generation-one' });
  assert.equal(opened[0].channel.closed, true); assert.equal(opened.length, 2);
  await adapter.exchange(frame, { binding: 'declaration-two' }); assert.equal(opened.length, 3);
  fail = true; const before = delivered.length;
  await assert.rejects(adapter.exchange(frame, { binding: 'declaration-two' }), /response lost/);
  assert.equal(delivered.length, before + 1); assert.equal(opened[2].channel.closed, true);
  fail = false; await adapter.exchange(frame, { binding: 'declaration-two' }); assert.equal(opened.length, 4);
  adapter.close(); assert.equal(opened[3].channel.closed, true);
});

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
    assert.match(script, /\[Security\.SecureString\]::new\(\)/u);
    assert.match(script, /\$secure\.MakeReadOnly\(\)/u);
    assert.match(script, /\$secure\.Dispose\(\)/u);
    assert.doesNotMatch(script, /ConvertTo-SecureString/u);
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
  const [canonicalKey, canonicalKnown] = await Promise.all([realpath(key), realpath(known)]);
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
      assert.ok(request.arguments.includes(`UserKnownHostsFile=${canonicalKnown}`));
      assert.ok(request.arguments.includes('GlobalKnownHostsFile=NUL'));
      assert.ok(request.arguments.includes('IdentitiesOnly=yes'));
      assert.ok(request.arguments.includes('ForwardAgent=no'));
      assert.ok(request.arguments.includes('ClearAllForwardings=yes'));
      assert.ok(request.arguments.includes('PasswordAuthentication=no'));
      const identityIndex = request.arguments.indexOf('-i');
      assert.ok(identityIndex >= 0);
      assert.equal(request.arguments[identityIndex + 1], canonicalKey);
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
