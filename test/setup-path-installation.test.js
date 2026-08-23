import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installStableDevBridgeCommand } from '../src/setup/path-installation.js';

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
    return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"changed":true}', stderr: '' };
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
    assert.equal(result.requiresNewShell, true);
    const launcher = await readFile(result.command, 'utf8');
    assert.match(launcher, /DevBridge managed launcher/u);
    assert.match(launcher, /devbridge-entry\.mjs/u);
    if (process.platform === 'win32') assert.equal(invocations.length, 1);
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
    assert.match(result.temporaryCommand, /devbridge-stage0\.mjs/u);
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