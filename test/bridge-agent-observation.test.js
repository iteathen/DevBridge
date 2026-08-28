import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agent = fileURLToPath(new URL('../src/guest/bridge-agent.mjs', import.meta.url));
const protocol = 'devbridge/environment-bridge-v1';
const recordProtocol = 'devbridge/environment-bridge-operation-v1';
const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NON_OBSERVABLE_MONITOR_PID = Number.MAX_SAFE_INTEGER;

async function exchange(root, request, kind, body = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agent, '--exchange-stdin'], {
      env: { ...process.env, DEVBRIDGE_GUEST_BRIDGE_ROOT: root, DEVBRIDGE_GUEST_TARGET: target },
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString('utf8') || `agent exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (error) { reject(new Error(`invalid agent output: ${out}`, { cause: error })); }
    });
    child.stdin.end(JSON.stringify({ protocol, request, target, kind, body }));
  });
}

test('a non-observable monitor identity remains indeterminate when the durable record is still nonterminal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-dead-monitor-'));
  const request = 'f'.repeat(32);
  try {
    await mkdir(path.join(root, '.operations'), { recursive: true });
    await writeFile(path.join(root, '.operations', `${request}.json`), `${JSON.stringify({
      protocol: recordProtocol,
      request,
      target,
      digest: '0'.repeat(64),
      body: {},
      state: 'running',
      createdAt: new Date().toISOString(),
      monitorPid: NON_OBSERVABLE_MONITOR_PID,
      childPid: null,
      result: null,
      reason: null,
    })}\n`, 'utf8');

    const observed = await exchange(root, request, 'observe');
    assert.equal(observed.ok, true);
    assert.equal(observed.body.state, 'indeterminate');
    assert.equal(observed.body.reason, 'bridge operation monitor is no longer observable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
