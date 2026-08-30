import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installStableDevBridgeCommand,
  resolveInstalledCommand,
} from '../src/setup/path-installation.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-setup-path-'));
  const home = path.join(root, '.devbridge');
  const bin = path.join(home, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'devbridge-entry.mjs'), 'console.log("entry");\n');
  return { root, home, bin };
}

function pathInvoke(invocations = []) {
  return async (request) => {
    invocations.push(request);
    return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"changed":true,"persisted":true}', stderr: '' };
  };
}

test('setup installs an owned stable command and persists its bin directory', async () => {
  const data = await fixture();
  try {
    const invocations = [];
    const result = await installStableDevBridgeCommand({
      home: data.home,
      platform: process.platform,
      homeDirectory: data.root,
      env: { ...process.env, PATH: '' },
      invoke: pathInvoke(invocations),
    });
    assert.equal(result.persisted, true);
    assert.equal(result.visibility, 'refresh-required');
    assert.match(result.invocation, /devbridge(?:\.cmd)?/u);
    const launcher = await readFile(result.command, 'utf8');
    assert.match(launcher, /DevBridge managed launcher/u);
    assert.match(launcher, /devbridge-entry\.mjs/u);
    if (process.platform === 'win32') {
      assert.equal(invocations.length, 1);
      const encoded = invocations[0].arguments.at(-1);
      const script = Buffer.from(encoded, 'base64').toString('utf16le');
      assert.match(script, /\$observed = \[Environment\]::GetEnvironmentVariable\('Path', 'User'\)/u);
      assert.match(script, /persisted = \$persisted/u);
      const parsed = spawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))) | Out-Null`,
      ], { encoding: 'utf8', windowsHide: true });
      assert.equal(parsed.status, 0, parsed.stderr);
    }
    else assert.match(await readFile(path.join(data.root, '.profile'), 'utf8'), /DevBridge managed PATH/u);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('setup preserves the active Stage 0 launcher when the permanent entry is not installed yet', async () => {
  const data = await fixture();
  try {
    await rm(path.join(data.bin, 'devbridge-entry.mjs'));
    const stage0 = path.join(data.root, 'downloaded-devbridge.mjs');
    await writeFile(stage0, '#!/usr/bin/env node\nexport const STAGE0_PROTOCOL = 1;\n');
    const result = await installStableDevBridgeCommand({
      home: data.home,
      stage0Launcher: stage0,
      platform: process.platform,
      homeDirectory: data.root,
      env: { ...process.env, PATH: '' },
      invoke: pathInvoke(),
    });
    assert.equal(result.launcher, path.join(data.bin, 'devbridge-stage0.mjs'));
    assert.equal(await readFile(result.launcher, 'utf8'), '#!/usr/bin/env node\nexport const STAGE0_PROTOCOL = 1;\n');
    assert.match(await readFile(`${result.launcher}.owner`, 'utf8'), /DevBridge managed Stage 0 source/u);
    assert.match(await readFile(result.command, 'utf8'), /devbridge-stage0\.mjs/u);
    assert.match(result.invocation, /devbridge(?:\.cmd)?/u);
    assert.doesNotMatch(result.invocation, /devbridge-stage0\.mjs/u);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('setup distinguishes a caller-omitted PATH from a persistence refresh', async () => {
  const data = await fixture();
  try {
    const result = await installStableDevBridgeCommand({
      home: data.home,
      platform: 'win32',
      homeDirectory: data.root,
      env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.CMD' },
      invoke: async () => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        stdout: '{"changed":false,"persisted":true}',
        stderr: '',
      }),
    });
    assert.equal(result.visibility, 'caller-omitted');
    assert.equal(result.command, path.join(data.bin, 'devbridge.cmd'));
    assert.equal(result.invocation, `& '${result.command}'`);
    assert.doesNotMatch(result.invocation, /node(?:\.exe)?\s/u);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('the installation resolver proves exact owned command content', async () => {
  const data = await fixture();
  try {
    const installed = await installStableDevBridgeCommand({
      home: data.home,
      platform: process.platform,
      homeDirectory: data.root,
      env: { ...process.env, PATH: '' },
      invoke: pathInvoke(),
    });
    assert.deepEqual(await resolveInstalledCommand({ home: data.home, platform: process.platform }), {
      command: installed.command,
      binDirectory: installed.binDirectory,
      launcher: installed.launcher,
      invocation: installed.invocation,
    });
    await writeFile(installed.command, `${await readFile(installed.command, 'utf8')}foreign\n`);
    await assert.rejects(
      () => resolveInstalledCommand({ home: data.home, platform: process.platform }),
      /content is not owned/u,
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('setup fails closed when post-write observation does not prove persistence', async () => {
  const data = await fixture();
  try {
    await assert.rejects(
      () => installStableDevBridgeCommand({
        home: data.home,
        platform: 'win32',
        homeDirectory: data.root,
        env: { PATH: '', PATHEXT: '.CMD' },
        invoke: async () => ({
          exitCode: 0,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          stdout: '{"changed":true,"persisted":false}',
          stderr: '',
        }),
      }),
      /was not persisted/u,
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('Windows persistence rejects widened structured output', async () => {
  const data = await fixture();
  try {
    await assert.rejects(
      () => installStableDevBridgeCommand({
        home: data.home,
        platform: 'win32',
        homeDirectory: data.root,
        env: { PATH: '', PATHEXT: '.CMD' },
        invoke: async () => ({
          exitCode: 0,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          stdout: '{"changed":true,"persisted":true,"source":"remote"}',
          stderr: '',
        }),
      }),
      /invalid structured output/u,
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('setup refuses to shadow an unrelated devbridge command', async () => {
  const data = await fixture();
  const foreign = path.join(data.root, 'foreign-bin');
  try {
    await mkdir(foreign, { recursive: true });
    const foreignCommand = process.platform === 'win32' ? path.join(foreign, 'devbridge.cmd') : path.join(foreign, 'devbridge');
    await writeFile(foreignCommand, 'foreign\n');
    await assert.rejects(
      () => installStableDevBridgeCommand({
        home: data.home,
        platform: process.platform,
        homeDirectory: data.root,
        env: { ...process.env, PATH: foreign, PATHEXT: '.CMD' },
        invoke: async () => { throw new Error('PATH persistence must not occur after collision'); },
      }),
      /existing unrelated devbridge command/u,
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});
