import test from 'node:test';
import assert from 'node:assert/strict';
import { LibvirtEnvironmentBridge } from '../src/runtime/providers/libvirt-environment-bridge.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const location = {
  reference: 'db-env-local-reference',
  identity: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  proof: 'local-ownership-proof',
};
const frame = { protocol: 'devbridge/environment-bridge-v1', request: '2'.repeat(32), target, kind: 'health', body: {} };
const reply = { protocol: frame.protocol, request: frame.request, target, kind: 'health', ok: true, body: { version: '1.0.0', features: ['health', 'execute', 'observe', 'cancel', 'put', 'get'] } };
const locate = async (receivedTarget) => { assert.equal(receivedTarget, target); return location; };
function success(stdout) { return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' }; }
function qgaResponse(value) { return success(JSON.stringify(value)); }

test('Linux attachment binds exact located ownership and uses QGA only as a fixed helper carrier', async () => {
  const calls = [];
  const invoke = async (request) => {
    calls.push(request);
    assert.equal(request.executable, 'virsh');
    assert.deepEqual(request.arguments.slice(0, 2), ['-c', 'qemu:///system']);
    const command = request.arguments[2];
    if (command === 'domuuid') { assert.equal(request.arguments[3], location.reference); return success(`${location.identity}\n`); }
    if (command === 'dumpxml') return success(`<domain><metadata>${location.proof}</metadata><devices><channel><target type="virtio" name="org.qemu.guest_agent.0"/></channel></devices></domain>`);
    if (command === 'domstate') return success('running\n');
    if (command === 'qemu-agent-command') {
      assert.equal(request.arguments[3], location.reference);
      assert.deepEqual(request.arguments.slice(4, 6), ['--timeout', '30']);
      const payload = JSON.parse(request.arguments[6]);
      if (payload.execute === 'guest-exec') {
        assert.equal(payload.arguments.path, 'node');
        assert.deepEqual(payload.arguments.arg, ['/usr/local/libexec/devbridge/bridge-agent.mjs', '--exchange-stdin']);
        assert.deepEqual(payload.arguments.env, [`DEVBRIDGE_GUEST_TARGET=${target}`]);
        assert.equal(Buffer.from(payload.arguments['input-data'], 'base64').toString('utf8'), JSON.stringify(frame));
        assert.equal(payload.arguments['capture-output'], true);
        return qgaResponse({ return: { pid: 41 } });
      }
      assert.equal(payload.execute, 'guest-exec-status');
      assert.equal(payload.arguments.pid, 41);
      return qgaResponse({ return: { exited: true, exitcode: 0, 'out-data': Buffer.from(JSON.stringify(reply)).toString('base64'), 'err-data': '', 'out-truncated': false, 'err-truncated': false } });
    }
    throw new Error(`unexpected command ${command}`);
  };
  const adapter = new LibvirtEnvironmentBridge({ invoke, locate, access: async () => ({ family: 'linux' }) });
  assert.deepEqual(await adapter.exchange(frame), reply);
  assert.equal(calls.some((call) => call.arguments.includes('guest-exec')), false, 'QGA names belong inside structured local command data, not separate executable authority');
});

test('Windows guest profile selects only the fixed Windows helper path inside QGA', async () => {
  let saw = false;
  const invoke = async (request) => {
    const command = request.arguments[2];
    if (command === 'domuuid') return success(`${location.identity}\n`);
    if (command === 'dumpxml') return success(`${location.proof} org.qemu.guest_agent.0`);
    if (command === 'domstate') return success('running\n');
    const payload = JSON.parse(request.arguments[6]);
    if (payload.execute === 'guest-exec') {
      saw = true;
      assert.equal(payload.arguments.path, 'node.exe');
      assert.deepEqual(payload.arguments.arg, ['C:\\ProgramData\\DevBridge\\bridge-agent.mjs', '--exchange-stdin']);
      return qgaResponse({ return: { pid: 2 } });
    }
    return qgaResponse({ return: { exited: true, exitcode: 0, 'out-data': Buffer.from(JSON.stringify(reply)).toString('base64'), 'err-data': '' } });
  };
  const adapter = new LibvirtEnvironmentBridge({ invoke, locate, access: async () => ({ family: 'windows' }) });
  await adapter.exchange(frame);
  assert.equal(saw, true);
});

test('truncated QGA output and ownership mismatch fail closed', async () => {
  let qgaCalls = 0;
  const truncated = new LibvirtEnvironmentBridge({ locate, access: async () => ({ family: 'linux' }), invoke: async (request) => {
    const command = request.arguments[2];
    if (command === 'domuuid') return success(`${location.identity}\n`);
    if (command === 'dumpxml') return success(`${location.proof} org.qemu.guest_agent.0`);
    if (command === 'domstate') return success('running\n');
    const payload = JSON.parse(request.arguments[6]);
    qgaCalls += 1;
    if (payload.execute === 'guest-exec') return qgaResponse({ return: { pid: 7 } });
    return qgaResponse({ return: { exited: true, exitcode: 0, 'out-data': Buffer.from('{}').toString('base64'), 'out-truncated': true } });
  } });
  await assert.rejects(() => truncated.exchange(frame), /output was truncated/u);
  assert.equal(qgaCalls, 2);

  let commands = 0;
  const foreign = new LibvirtEnvironmentBridge({ locate, access: async () => ({ family: 'linux' }), invoke: async (request) => {
    commands += 1;
    if (request.arguments[2] === 'domuuid') return success('00000000-0000-4000-8000-000000000000\n');
    throw new Error('must not continue');
  } });
  await assert.rejects(() => foreign.exchange(frame), /ownership identity does not match/u);
  assert.equal(commands, 1);
});

test('attachment rejects malformed injected location before any provider command', async () => {
  let commands = 0;
  const adapter = new LibvirtEnvironmentBridge({
    access: async () => ({ family: 'linux' }),
    locate: async () => ({ reference: 'ok', identity: 'not-an-identity', proof: 'proof' }),
    invoke: async () => { commands += 1; throw new Error('must not invoke'); },
  });
  await assert.rejects(() => adapter.exchange(frame), /location\.identity is invalid/u);
  assert.equal(commands, 0);
});
