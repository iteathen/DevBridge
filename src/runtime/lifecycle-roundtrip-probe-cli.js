#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runLifecycleRoundtripProbe } from './lifecycle-roundtrip-probe.js';
import { WORKER_RESULT_FILE } from './worker-exchange.js';

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const raw = await readStdin();
  const context = JSON.parse(raw);
  if (context?.protocol !== 'patch-poller/context-v1') throw new Error('lifecycle roundtrip diagnostic requires patch-poller/context-v1');
  if (context?.bridge?.resultFile !== WORKER_RESULT_FILE) {
    throw new Error('lifecycle roundtrip diagnostic requires the fixed PATCH-POLLER worker result endpoint');
  }

  const projectRoot = path.resolve(process.cwd());
  const result = await runLifecycleRoundtripProbe({
    projectRoot,
    context,
    env: process.env
  });
  await writeFile(WORKER_RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
  process.stdout.write(`${JSON.stringify({ diagnostic: 'lifecycle-roundtrip', status: result.status })}\n`);
}

main().catch((error) => {
  process.stderr.write(`lifecycle-roundtrip-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
