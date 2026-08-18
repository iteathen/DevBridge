import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { expandProfileArgs } from './cli-profile.js';
import { resolveExecutable } from './executable-resolver.js';

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
  for (const name of profile.environment.pass) {
    if (source[name] != null) env[name] = source[name];
  }
  Object.assign(env, profile.environment.set);
  return env;
}

export class ProcessRunner {
  #resolver;
  #sourceEnv;

  constructor({ executableResolver = resolveExecutable, sourceEnv = process.env } = {}) {
    this.#resolver = executableResolver;
    this.#sourceEnv = sourceEnv;
  }

  async run({ profile, projectDir, runDir, runId, context }) {
    const projectRoot = path.resolve(projectDir);
    const resolvedRunDir = path.resolve(runDir);
    if (!isWithin(projectRoot, resolvedRunDir)) throw new PolicyError('run directory must be inside the project directory');

    await mkdir(resolvedRunDir, { recursive: true });
    const contextFile = path.join(resolvedRunDir, 'context.json');
    const resultFile = path.join(resolvedRunDir, 'result.json');
    await writeFile(contextFile, `${JSON.stringify(context, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    const executable = await this.#resolver(profile.executable, this.#sourceEnv);
    const args = expandProfileArgs(profile.args, { projectDir: projectRoot, contextFile, resultFile, runId });
    const env = buildEnvironment(profile, this.#sourceEnv);
    env.PATCH_POLLER_RUN_ID = String(runId);

    let stdin = null;
    if (profile.inputMode === 'stdin-json') stdin = `${JSON.stringify(context)}\n`;
    else if (profile.inputMode === 'stdin-text') stdin = `PATCH-POLLER CONTEXT\n${JSON.stringify(context, null, 2)}\n`;

    const child = spawn(executable, args, {
      cwd: projectRoot,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;

    child.stdout.on('data', (chunk) => {
      const next = appendTail(stdout, chunk, profile.maxOutputBytes);
      stdout = next.buffer;
      outputTruncated ||= next.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const next = appendTail(stderr, chunk, profile.maxOutputBytes);
      stderr = next.buffer;
      outputTruncated ||= next.truncated;
    });

    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, profile.timeoutMs);
    timer.unref?.();

    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));

    let result = null;
    try {
      const info = await stat(resultFile);
      if (info.size <= 1_048_576) result = JSON.parse(await readFile(resultFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }

    return {
      executable,
      args,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      outputTruncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      result,
      contextFile,
      resultFile
    };
  }
}
