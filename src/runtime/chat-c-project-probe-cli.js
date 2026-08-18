#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runChatCProjectProbe } from './chat-c-project-probe.js';
import { WORKER_RESULT_FILE } from './worker-exchange.js';

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const context = JSON.parse(await readStdin());
  if (context?.protocol !== 'patch-poller/context-v1') {
    throw new Error('chat C project diagnostic requires patch-poller/context-v1');
  }
  if (context?.bridge?.resultFile !== WORKER_RESULT_FILE) {
    throw new Error('chat C project diagnostic requires the fixed PATCH-POLLER worker result endpoint');
  }

  const projectRoot = path.resolve(process.cwd());
  // This profile ignores free-form task instructions for file contents, paths,
  // executable selection, process arguments, and verification policy. The C
  // project is authored in trusted PATCH-POLLER runtime code by the chat-only
  // controller and materialized deterministically into the managed worktree.
  const result = await runChatCProjectProbe({ projectRoot, env: process.env });
  await writeFile(WORKER_RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
  process.stdout.write(`${JSON.stringify({ diagnostic: 'chat-c-project', status: result.status })}\n`);
}

main().catch((error) => {
  process.stderr.write(`chat-c-project-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
