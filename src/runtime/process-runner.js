import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { expandProfileArgs } from './cli-profile.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function appendTail(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - maxBytes), truncated: true };
}
function buildEnvironment(profile, source) {
  const env = {};
  for (const name of profile.environment.pass) if (source[name] != null) env[name] = source[name];
  Object.assign(env, profile.environment.set);
  env.GIT_TERMINAL_PROMPT = '0';
  env.PATCH_POLLER_NONINTERACTIVE = '1';
  env.NO_COLOR ??= '1';
  return env;
}

export function toolBridge(runId, resultFile) {
  return {
    protocol: 'patch-poller/tool-bridge-v1',
    runId: String(runId),
    resultFile,
    resultProtocol: 'patch-poller/result-v1',
    requirement: 'Before exiting, write one JSON result envelope to resultFile when the CLI can do so. PATCH-POLLER independently validates the workspace; never claim completion unless the requested work and checks are complete.',
    resultSchema: {
      required: ['protocol', 'status', 'summary'],
      protocol: 'patch-poller/result-v1',
      status: ['complete', 'continue', 'blocked', 'failed'],
      summary: 'Required non-empty string, maximum 20000 characters.',
      progress: 'Optional array of at most 100 strings, each at most 4000 characters.',
      tests: 'Optional array of at most 100 bounded JSON values describing checks actually run.',
      nextStep: 'Optional string of at most 8000 characters or null.',
      blocker: 'Optional string of at most 8000 characters or null; use for a concrete blocked/failed cause.',
      checkpoint: 'Optional bounded JSON object for a proposal checkpoint; it is not human authorization.'
    },
    example: {
      protocol: 'patch-poller/result-v1',
      status: 'complete',
      summary: 'Implemented and verified the requested change.',
      progress: [],
      tests: [],
      nextStep: null,
      blocker: null
    }
  };
}

export class ProcessRunner {
  #resolver;
  #sourceEnv;
  constructor({ executableResolver = resolveExecutable, sourceEnv = process.env } = {}) { this.#resolver = executableResolver; this.#sourceEnv = sourceEnv; }

  async run({ profile, projectDir, runDir, runId, context }) {
    const projectRoot = path.resolve(projectDir);
    const resolvedRunDir = path.resolve(runDir);
    if (!isWithin(projectRoot, resolvedRunDir)) throw new PolicyError('run directory must be inside the project directory');
    await mkdir(resolvedRunDir, { recursive: true });
    const contextFile = path.join(resolvedRunDir, 'context.json');
    const resultFile = path.join(resolvedRunDir, 'result.json');
    const toolContext = { ...context, bridge: toolBridge(runId, resultFile) };
    await writeFile(contextFile, `${JSON.stringify(toolContext, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    const executable = await this.#resolver(profile.executable, this.#sourceEnv);
    const args = expandProfileArgs(profile.args, { projectDir: projectRoot, contextFile, resultFile, runId });
    const env = buildEnvironment(profile, this.#sourceEnv);
    env.PATCH_POLLER_RUN_ID = String(runId);
    let stdin = null;
    if (profile.inputMode === 'stdin-json') stdin = `${JSON.stringify(toolContext)}\n`;
    else if (profile.inputMode === 'stdin-text') stdin = `PATCH-POLLER CONTEXT\n${JSON.stringify(toolContext, null, 2)}\n`;

    const child = spawn(executable, args, containedSpawnOptions({ cwd: projectRoot, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    child.stdout.on('data', (chunk) => { const next = appendTail(stdout, chunk, profile.maxOutputBytes); stdout = next.buffer; outputTruncated ||= next.truncated; });
    child.stderr.on('data', (chunk) => { const next = appendTail(stderr, chunk, profile.maxOutputBytes); stderr = next.buffer; outputTruncated ||= next.truncated; });
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();

    let timedOut = false;
    let termination = null;
    const timer = setTimeout(() => { timedOut = true; termination = terminateProcessTree(child); }, profile.timeoutMs);
    timer.unref?.();
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }).finally(async () => { clearTimeout(timer); if (termination) await termination; });

    let result = null;
    let resultParseError = null;
    try {
      const info = await stat(resultFile);
      if (info.size > 1_048_576) resultParseError = 'result file exceeds 1 MiB';
      else {
        try { result = JSON.parse(await readFile(resultFile, 'utf8')); }
        catch (error) { if (error instanceof SyntaxError) resultParseError = error.message; else throw error; }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    return { executable, args, exitCode: exit.code, signal: exit.signal, timedOut, outputTruncated, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), result, resultParseError, contextFile, resultFile };
  }
}
