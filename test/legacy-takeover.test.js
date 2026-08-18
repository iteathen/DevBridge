import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  stopExistingDaemon,
  validateLegacyDaemonIdentity,
} from '../patch-poller.mjs';

test('legacy takeover escalates after a bounded number of cooperative stop attempts', async () => {
  let stops = 0;
  let forced = 0;
  const result = await stopExistingDaemon(
    { config: '/operator/config.json' },
    { cliPath: '/managed/runtime/src/cli.js' },
    undefined,
    {
      maxGraceAttempts: 2,
      stopCommandFn: () => {
        stops += 1;
        return { status: 3, stdout: '', stderr: '' };
      },
      forceLegacyStopFn: async () => {
        forced += 1;
        return { forced: true, pid: 42 };
      },
      delayFn: async () => {},
    },
  );
  assert.equal(stops, 2);
  assert.equal(forced, 1);
  assert.deepEqual(result, { forced: true, pid: 42 });
});

test('legacy takeover does not force a daemon that stops cooperatively', async () => {
  let forced = 0;
  const result = await stopExistingDaemon(
    { config: '/operator/config.json' },
    { cliPath: '/managed/runtime/src/cli.js' },
    undefined,
    {
      stopCommandFn: () => ({ status: 0, stdout: '', stderr: '' }),
      forceLegacyStopFn: async () => { forced += 1; },
    },
  );
  assert.equal(forced, 0);
  assert.deepEqual(result, { forced: false });
});

test('legacy forced takeover requires exact PATCH-POLLER daemon identity', () => {
  const paths = { config: path.resolve('/operator/config.json') };
  const runtime = { cliPath: path.resolve('/managed/runtime/src/cli.js') };
  assert.equal(validateLegacyDaemonIdentity({
    processId: 42,
    name: 'node.exe',
    commandLine: `node.exe "${runtime.cliPath}" daemon --config "${paths.config}"`,
  }, { paths, runtime }), true);
  assert.throws(() => validateLegacyDaemonIdentity({
    processId: 42,
    name: 'node.exe',
    commandLine: 'node.exe C:\\other\\service.js daemon --config C:\\other\\config.json',
  }, { paths, runtime }), /refusing forced takeover/u);
});
