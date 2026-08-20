#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runNativeCompilerProbe } from './native-compiler-probe.js';
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
  if (context?.protocol !== 'devbridge/context-v1') throw new Error('native compiler diagnostic requires devbridge/context-v1');

  // The diagnostic ignores free-form task instructions for process selection.
  // Compiler discovery and all compiler arguments are fixed control-plane code.
  // Build scratch is sandbox-local and separate from the control-owned mailbox.
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'devbridge-native-compiler-'));
  try {
    const result = await runNativeCompilerProbe({ workDir, env: process.env });
    emitResult(result);
    process.stdout.write(`${JSON.stringify({ diagnostic: 'native-compiler', status: result.status })}\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  process.stderr.write(`native-compiler-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
