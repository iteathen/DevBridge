import { spawn } from 'node:child_process';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { expandProfileArgs } from './cli-profile.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';
import { WorkerExchange } from './worker-exchange.js';

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

function unwrapSingleJsonFence(text) {
  const match = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  return match ? match[1].trim() : text;
}

export function parseResultJsonText(text) {
  let normalized = String(text);
  if (normalized.charCodeAt(0) === 0xFEFF) normalized = normalized.slice(1);
  normalized = normalized.trim();
  normalized = unwrapSingleJsonFence(normalized);
  return JSON.parse(normalized);
}

export function toolBridge(runId, resultFile) {
  return {
    protocol: 'patch-poller/tool-bridge-v1',
    runId: String(runId),
    resultFile,
    resultProtocol: 'patch-poller/result-v1',
    requirement: 'Before exiting, write one JSON result envelope to resultFile when the CLI can do so. PATCH-POLLER independently validates the workspace; never claim completion unless the requested work and checks are complete.',
    gitAuthority: {
      owner: 'patch-poller',
      rule: 'Project edits are proposals. Do not stage, commit, reset, checkout, clean, push, or otherwise write Git administrative state. Do not write .git or linked-worktree metadata. Read-only Git inspection is allowed. Leave accepted project edits in the working tree; PATCH-POLLER validates, stages, seals, commits, and publishes them.'
    },
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
  #sandbox;
  #exchange;
  #allowUncontained;

  constructor({ executableResolver = resolveExecutable, sourceEnv = process.env, sandboxProvider = null, workerExchange = null, allowUncontainedTools = false } = {}) {
    this.#resolver = executableResolver;
    this.#sourceEnv = sourceEnv;
    this.#sandbox = sandboxProvider;
    this.#exchange = workerExchange;
    this.#allowUncontained = allowUncontainedTools === true;
  }

  sandboxStatus() {
    return this.#sandbox?.inspect?.() ?? {
      provider: 'none', configured: false, verified: false, verification: 'unavailable', reason: 'no sandbox provider attached to proposal runner'
    };
  }

  async run({ profile, projectDir, runDir = null, runId, turnId = null, context }) {
    const projectRoot = path.resolve(projectDir);
    const exchange = this.#exchange ?? new WorkerExchange({ root: path.join(path.dirname(projectRoot), '.patch-poller-worker-exchange') });
    const exchangeTurn = String(turnId ?? (runDir ? path.basename(path.resolve(runDir)) : 'turn-1'));
    const prepared = await exchange.prepare({
      runId,
      turnId: exchangeTurn,
      context: ({ resultFile }) => ({ ...context, bridge: toolBridge(runId, resultFile) }),
    });
    const toolContext = prepared.context;

    try {
      const executable = await this.#resolver(profile.executable, this.#sourceEnv);
      const args = expandProfileArgs(profile.args, { projectDir: projectRoot, contextFile: prepared.contextFile, resultFile: prepared.resultFile, runId });
      const env = buildEnvironment(profile, this.#sourceEnv);
      env.PATCH_POLLER_RUN_ID = String(runId);
      let stdin = null;
      if (profile.inputMode === 'stdin-json') stdin = `${JSON.stringify(toolContext)}\n`;
      else if (profile.inputMode === 'stdin-text') stdin = `PATCH-POLLER CONTEXT\n${JSON.stringify(toolContext, null, 2)}\n`;

      let launch = { executable, args, cwd: projectRoot, environment: env, provider: 'direct-development-override' };
      if (profile.sandbox.requiresVerifiedSandbox !== false || !this.#allowUncontained) {
        const status = this.sandboxStatus();
        if (!status.verified || !this.#sandbox?.prepareSpawn) {
          throw new PolicyError(`tool profile ${profile.name} requires verified containment but no verified sandbox provider is active`);
        }
        launch = await this.#sandbox.prepareSpawn({
          executable,
          args,
          cwd: projectRoot,
          environment: env,
          sandbox: {
            projectRoot,
            projectWritable: true,
            writableRoots: [],
            readOnlyRoots: [],
            exchangeDir: prepared.exchangeDir,
            resultFile: prepared.resultFile,
            network: profile.sandbox.network,
          },
        });
      }

      const child = spawn(launch.executable, launch.args, containedSpawnOptions({ cwd: launch.cwd, env: launch.environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
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
      const resultText = await prepared.consumeResult();
      if (resultText.trim() !== '') {
        try { result = parseResultJsonText(resultText); }
        catch (error) { if (error instanceof SyntaxError) resultParseError = error.message; else throw error; }
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
        resultParseError,
        contextFile: prepared.contextFile,
        resultFile: prepared.resultFile,
        exchangeDir: prepared.exchangeDir,
        sandboxProvider: launch.provider ?? null,
      };
    } finally {
      await prepared.cleanup();
    }
  }
}
