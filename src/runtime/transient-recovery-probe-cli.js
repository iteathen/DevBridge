#!/usr/bin/env node
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CAPACITY_ERROR = 'ERROR: Selected model is at capacity. Please try a different model.';
const STATE_PROTOCOL = 'patch-poller/transient-recovery-probe-v1';

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

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
  if (context?.protocol !== 'patch-poller/context-v1') throw new Error('transient recovery diagnostic requires patch-poller/context-v1');
  const resultFile = context?.bridge?.resultFile;
  if (typeof resultFile !== 'string' || !path.isAbsolute(resultFile)) throw new Error('transient recovery diagnostic requires an absolute PATCH-POLLER resultFile');

  const projectRoot = path.resolve(process.cwd());
  const resolvedResult = path.resolve(resultFile);
  if (!isWithin(projectRoot, resolvedResult)) throw new Error('transient recovery diagnostic resultFile must remain inside the managed project');

  const turnDir = path.dirname(resolvedResult);
  const runRoot = path.dirname(turnDir);
  if (!isWithin(projectRoot, runRoot)) throw new Error('transient recovery diagnostic state must remain inside the managed project');
  const stateFile = path.join(runRoot, 'transient-recovery-state.json');
  const attempt = (await readAttempt(stateFile)) + 1;
  await writeFile(stateFile, `${JSON.stringify({ protocol: STATE_PROTOCOL, attempt })}\n`, { encoding: 'utf8', mode: 0o600 });

  if (attempt <= 2) {
    process.stderr.write(`${CAPACITY_ERROR}\n`);
    process.exitCode = 1;
    return;
  }

  const result = {
    protocol: 'patch-poller/result-v1',
    status: 'complete',
    summary: `Deterministic transient recovery diagnostic completed after ${attempt} attempts.`,
    progress: ['Two synthetic capacity failures were recovered inside one durable PATCH-POLLER run.'],
    tests: [{ name: 'transient-recovery-attempts', attempts: attempt, expectedAttempts: 3, status: attempt === 3 ? 'pass' : 'unexpected' }],
    nextStep: null,
    blocker: null
  };
  await writeFile(resolvedResult, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rm(stateFile, { force: true });
  process.stdout.write(`${JSON.stringify({ diagnostic: 'transient-recovery', attempt, status: 'complete' })}\n`);
}

main().catch((error) => {
  process.stderr.write(`transient-recovery-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
