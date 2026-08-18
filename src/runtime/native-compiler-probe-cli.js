#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runNativeCompilerProbe } from './native-compiler-probe.js';

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
  const raw = await readStdin();
  const context = JSON.parse(raw);
  if (context?.protocol !== 'patch-poller/context-v1') throw new Error('native compiler diagnostic requires patch-poller/context-v1');
  const resultFile = context?.bridge?.resultFile;
  if (typeof resultFile !== 'string' || !path.isAbsolute(resultFile)) throw new Error('native compiler diagnostic requires an absolute PATCH-POLLER resultFile');
  const projectRoot = path.resolve(process.cwd());
  const resolvedResult = path.resolve(resultFile);
  if (!isWithin(projectRoot, resolvedResult)) throw new Error('native compiler diagnostic resultFile must remain inside the managed project');

  // The diagnostic ignores free-form task instructions for process selection.
  // Compiler discovery and all compiler arguments are fixed control-plane code.
  const result = await runNativeCompilerProbe({
    workDir: path.dirname(resolvedResult),
    env: process.env
  });
  await writeFile(resolvedResult, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ diagnostic: 'native-compiler', status: result.status })}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`native-compiler-diagnostic: ${String(error?.message || error).slice(0, 1000)}\n`);
  process.exitCode = 1;
});
