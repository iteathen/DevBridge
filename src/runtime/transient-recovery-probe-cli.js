#!/usr/bin/env node
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { emitResult } from './result-emission.js';

const CAPACITY_ERROR = 'ERROR: Selected model is at capacity. Please try a different model.';
const STATE_PROTOCOL = 'devbridge/transient-recovery-probe-v1';
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function readAttempt(stateFile) {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    if (value?.protocol !== STATE_PROTOCOL || !Number.isSafeInteger(value.attempt) || value.attempt < 0) {
      throw new Error('transient diagnostic state is malformed');
    }
    return value.attempt;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function main() {
  const context = JSON.parse(await readStdin());
  if (context?.protocol !== 'devbridge/context-v1') throw new Error('transient recovery diagnostic requires devbridge/context-v1');
  const runId = String(context?.actions?.identity ?? '');
  if (!SAFE_RUN_ID.test(runId) || runId === '.' || runId === '..') {
    throw new Error('transient recovery diagnostic requires a safe work identity');
  }

  // This is disposable probe progress only, not control-plane authority or IPC.
  // It lives in the proposal tree so it survives the first two synthetic
  // failures, and is removed before the successful candidate is sealed.
  const projectRoot = path.resolve(process.cwd());
  const stateFile = path.join(projectRoot, `.devbridge-transient-recovery-${runId}.json`);
  const attempt = (await readAttempt(stateFile)) + 1;
  await writeFile(stateFile, `${JSON.stringify({ protocol: STATE_PROTOCOL, attempt })}\n`, { encoding: 'utf8', mode: 0o600 });

  if (attempt <= 2) {
    process.stderr.write(`${CAPACITY_ERROR}\n`);
    process.exitCode = 1;
    return;
  }

  const result = {
    protocol: 'devbridge/result-v1',
    status: 'complete',
    summary: `Deterministic transient recovery diagnostic completed after ${attempt} attempts.`,
    progress: ['Two synthetic capacity failures were recovered inside one durable DevBridge run.'],
    tests: [{ name: 'transient-recovery-attempts', attempts: attempt, expectedAttempts: 3, status: attempt === 3 ? 'pass' : 'unexpected' }],
    nextStep: null,
    blocker: null
  };
  emitResult(result);
  await rm(stateFile, { force: true });
  process.stdout.write(`${JSON.stringify({ diagnostic: 'transient-recovery', attempt, status: 'complete' })}\n`);
}

main().catch((error) => {
  process.stderr.write(`transient-recovery-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
