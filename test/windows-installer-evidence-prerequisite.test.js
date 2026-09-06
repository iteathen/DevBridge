import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import { reconcileWindowsInstallerEvidencePrerequisite, inspectWindowsInstallerEvidenceRegistration } from '../src/setup/windows-installer-evidence-prerequisite.js';
import { hyperVInstallerEvidenceService } from '../src/runtime/providers/hyperv-installer-evidence.js';

const identity = 'a'.repeat(32);
const stateDirectory = path.join(os.tmpdir(), 'db-prerequisite-contract-only');
const identitySource = async request => {
  assert.equal(request.directory, path.join(stateDirectory, 'environment-foundation'));
  return identity;
};
const response = (state, elevated = false, changed = false) => ({ exitCode: 0, stdout: JSON.stringify({ state, elevated, changed }) });
const run = invoke => reconcileWindowsInstallerEvidencePrerequisite({ stateDirectory, invoke, environment: {} }, { identitySource });

test('missing nonadmin or conflicting registration cannot invoke establishment', async () => {
  for (const [state, elevated] of [['absent', false], ['foreign', false], ['foreign', true], ['ready', false]]) {
    const actions = [];
    const result = await run(async request => {
      const input = JSON.parse(request.input);
      actions.push(input.action);
      assert.deepEqual(input, { ...hyperVInstallerEvidenceService(identity), action: 'inspect' });
      assert.equal(request.timeoutMs, 30_000);
      assert.equal(request.maxOutputBytes, 16 * 1024);
      return response(state, elevated);
    });
    assert.deepEqual(actions, ['inspect']);
    assert.equal(result.ready, state === 'ready');
    assert.equal(result.changed, false);
  }
});

test('establishment requires independent readback and later re-entry observes before repeating any effect', async () => {
  const actions = [];
  const replies = [response('absent', true), response('ready', true, true), response('ready', true), response('ready', false)];
  const invoke = async request => { actions.push(JSON.parse(request.input).action); return replies.shift(); };
  assert.deepEqual(await run(invoke), { ready: true, changed: true, blocker: null });
  assert.deepEqual(await run(invoke), { ready: true, changed: false, blocker: null });
  assert.deepEqual(actions, ['inspect', 'establish', 'inspect', 'inspect']);
});

test('lost establishment response and conflicting readback preserve unavailability without a blind retry', async () => {
  for (const replies of [
    [response('absent', true), { exitCode: 1, timedOut: true }],
    [response('absent', true), response('ready', true, true), response('foreign', true)],
  ]) {
    const actions = [];
    const result = await run(async request => { actions.push(JSON.parse(request.input).action); return replies.shift(); });
    assert.equal(result.ready, false);
    assert.equal(result.uncertain, true);
    assert.equal(actions.filter(action => action === 'establish').length, 1);
  }
});

test('malformed inspection or identity never authorizes a native registration', async () => {
  for (const value of [response('absent', 'yes'), response('ready', false, true), { ...response('ready'), outputTruncated: true }, { exitCode: 0, stdout: '{}' }]) {
    let calls = 0;
    await assert.rejects(run(async request => { calls++; assert.equal(JSON.parse(request.input).action, 'inspect'); return value; }));
    assert.equal(calls, 1);
  }
  await assert.rejects(inspectWindowsInstallerEvidenceRegistration({ identity: '../escape', invoke: async () => assert.fail('invalid identity invoked host') }), /identity/u);
});

test('Windows parses the exact prerequisite script without evaluating registry operations', { skip: process.platform !== 'win32' }, async () => {
  let script;
  await run(async request => { script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le'); return response('absent'); });
  assert.doesNotMatch(script, /-Force\b|RunAs|Start-Process|Remove-Item|Set-Acl/u);
  const parseOnly = "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }; [Console]::WriteLine('parsed')";
  const result = await invokeCommand({ executable: 'powershell.exe', arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parseOnly, 'utf16le').toString('base64')], input: script, timeoutMs: 15_000, maxOutputBytes: 8192 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'parsed');
});
