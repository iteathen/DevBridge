import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expandProfileArgs } from './cli-profile.js';
import { ControlMailbox } from './control-mailbox.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

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
    requirement: 'Before exiting, overwrite the pre-created resultFile with one JSON result envelope when the CLI can do so. PATCH-POLLER independently validates the workspace; never claim completion unless the requested work and checks are complete.',
    gitAuthority: {
      owner: 'patch-poller',
      rule: 'Project edits are proposals. Git administrative state is intentionally not part of the worker contract. Do not stage, commit, reset, checkout, clean, push, or access/write .git or linked-worktree metadata. PATCH-POLLER validates, stages, seals, commits, and publishes accepted project edits.'
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

function resolvedTurnId(turnId, runDir) {
  if (turnId != null) return `turn-${String(turnId)}`;
  if (typeof runDir === 'string' && runDir) return path.basename(path.resolve(runDir));
  return 'turn-0';
}

export class ProcessRunner {
  #resolver;
  #sourceEnv;
  #mailbox;

  constructor({ executableResolver = resolveExecutable, sourceEnv = process.env, exchangeRoot = null, mailbox = null } = {}) {
    this.#resolver = executableResolver;
    this.#sourceEnv = sourceEnv;
    const root = exchangeRoot ?? path.join(os.tmpdir(), `patch-poller-control-exchange-${process.pid}-${randomUUID()}`);
    this.#mailbox = mailbox ?? new ControlMailbox({ root: path.resolve(root) });
  }

  async run({ profile, projectDir, runDir = null, runId, turnId = null, context }) {
    const projectRoot = path.resolve(projectDir);
    const exchange = await this.#mailbox.prepare({ runId, turnId: resolvedTurnId(turnId, runDir) });
    const toolContext = { ...context, bridge: toolBridge(runId, exchange.resultFile) };
    await this.#mailbox.writeContext(exchange, `${JSON.stringify(toolContext, null, 2)}\n`);

    const executable = await this.#resolver(profile.executable, this.#sourceEnv);
    const args = expandProfileArgs(profile.args, {
      projectDir: projectRoot,
      contextFile: exchange.contextFile,
      resultFile: exchange.resultFile,
      runId,
    });
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
    const consumed = await this.#mailbox.consumeResult(exchange);
    if (consumed.text != null) {
      try { result = parseResultJsonText(consumed.text); }
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
      contextFile: exchange.contextFile,
      resultFile: exchange.resultFile,
      mailbox: { runDigest: exchange.runDigest, turnId: exchange.turnId, nonce: exchange.nonce },
    };
  }
}
