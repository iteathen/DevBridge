#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { runLifecycleRoundtripProbe } from './lifecycle-roundtrip-probe.js';
import { emitResult } from './result-emission.js';

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const raw = await readStdin();
  const context = JSON.parse(raw);
  if (context?.protocol !== 'devbridge/context-v1') throw new Error('lifecycle roundtrip diagnostic requires devbridge/context-v1');

  const projectRoot = path.resolve(process.cwd());
  const result = await runLifecycleRoundtripProbe({
    projectRoot,
    context,
    env: process.env
  });
  emitResult(result);
  process.stdout.write(`${JSON.stringify({ diagnostic: 'lifecycle-roundtrip', status: result.status })}\n`);
}

main().catch((error) => {
  process.stderr.write(`lifecycle-roundtrip-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
