#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runChatCProjectProbe } from './chat-c-project-probe.js';

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

async function main() {
  const context = JSON.parse(await readStdin());
  if (context?.protocol !== 'patch-poller/context-v1') {
    throw new Error('chat C project diagnostic requires patch-poller/context-v1');
  }

  const resultFile = context?.bridge?.resultFile;
  if (typeof resultFile !== 'string' || !path.isAbsolute(resultFile)) {
    throw new Error('chat C project diagnostic requires an absolute PATCH-POLLER resultFile');
  }

  const projectRoot = path.resolve(process.cwd());
  const resolvedResult = path.resolve(resultFile);
  if (!isWithin(projectRoot, resolvedResult)) {
    throw new Error('chat C project diagnostic resultFile must remain inside the managed project');
  }

  // This profile ignores free-form task instructions for file contents, paths,
  // executable selection, process arguments, and verification policy. The C
  // project is authored in trusted PATCH-POLLER runtime code by the chat-only
  // controller and materialized deterministically into the managed worktree.
  const result = await runChatCProjectProbe({ projectRoot, env: process.env });
  await writeFile(resolvedResult, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  process.stdout.write(`${JSON.stringify({ diagnostic: 'chat-c-project', status: result.status })}\n`);
}

main().catch((error) => {
  process.stderr.write(`chat-c-project-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
