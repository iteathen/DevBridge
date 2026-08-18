import { spawn } from 'node:child_process';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { expandProfileArgs } from './cli-profile.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';
import { WORKER_CONTEXT_FILE, WORKER_RESULT_FILE } from './worker-exchange.js';

const CONTROL_CREDENTIAL_ENVIRONMENT = new Set([
  'PATCH_POLLER_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
]);

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
    if (!CONTROL_CREDENTIAL_ENVIRONMENT.has(name) && source[name] != null) env[name] = source[name];
  }
  for (const [name, value] of Object.entries(profile.environment.set)) {
    if (!CONTROL_CREDENTIAL_ENVIRONMENT.has(name)) env[name] = value;
  }
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

async function consumeMailboxResult(mailbox) {
  let result = null;
  let resultParseError = null;
  const consumed = await mailbox.consumeResult({ maxBytes: 1_048_576 });
  resultParseError = consumed.resultParseError;
  if (consumed.text != null && !resultParseError) {
    try { result = parseResultJsonText(consumed.text); }
    catch (error) {
      if (error instanceof SyntaxError) resultParseError = error.message;
      else throw error;
    }
  }
  return { result, resultParseError, resultPresent: consumed.text != null };
}

export function toolBridge(runId, resultFile) {
  return {
    protocol: 'patch-poller/tool-bridge-v1',
    runId: String(runId),
    resultFile,
    resultProtocol: 'patch-poller/result-v1',
    requirement: 'Before exiting, overwrite the existing resultFile in place with one JSON result envelope when the CLI can do so. Do not unlink, rename over, symlink, or replace the mailbox file. PATCH-POLLER independently validates the workspace; never claim completion unless the requested work and checks are complete.',
    gitAuthority: {
      owner: 'patch-poller',
      rule: 'Project edits are proposals. Do not stage, commit, reset, checkout, clean, push, or otherwise write Git administrative state. Do not write .git or linked-worktree metadata. Do not rely on Git administrative state being available inside the worker boundary; any available read-only Git inspection is observational only. Leave accepted project edits in the working tree; PATCH-POLLER validates, stages, seals, commits, and publishes them.'
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
  #exchange;
  #sandboxProvider;

  constructor({
    executableResolver = resolveExecutable,
    sourceEnv = process.env,
    workerExchange = null,
    sandboxProvider = null,
  } = {}) {
    this.#resolver = executableResolver;
    this.#sourceEnv = sourceEnv;
    this.#exchange = workerExchange;
    this.#sandboxProvider = sandboxProvider;
  }

  #turnIdentity(projectDir, runDir) {
    const projectRoot = path.resolve(projectDir);
    const resolvedRunDir = path.resolve(runDir);
    if (!isWithin(projectRoot, resolvedRunDir)) throw new PolicyError('run identity path must be inside the project directory');
    return { projectRoot, turnId: path.basename(resolvedRunDir) };
  }

  async recoverResult({ projectDir, runDir, runId }) {
    if (!this.#exchange) throw new PolicyError('worker recovery requires a control-plane-owned worker exchange');
    const { turnId } = this.#turnIdentity(projectDir, runDir);
    const mailbox = await this.#exchange.openTurn({ runId, turnId });
    const consumed = await consumeMailboxResult(mailbox);
    return {
      executable: null,
      args: [],
      exitCode: null,
      signal: null,
      timedOut: false,
      outputTruncated: false,
      stdout: '',
      stderr: '',
      recovered: true,
      ...consumed,
      contextFile: mailbox.contextFile,
      resultFile: mailbox.resultFile,
      workerContextFile: mailbox.workerContextFile,
      workerResultFile: mailbox.workerResultFile,
      sandbox: null,
    };
  }

  async run({ profile, projectDir, runDir, runId, context }) {
    if (!this.#exchange) throw new PolicyError('worker execution requires a control-plane-owned worker exchange');
    if (!this.#sandboxProvider || typeof this.#sandboxProvider.prepareExecution !== 'function') {
      throw new PolicyError('worker execution requires a verified OS isolation provider');
    }

    const { projectRoot, turnId } = this.#turnIdentity(projectDir, runDir);
    const toolContext = { ...context, bridge: toolBridge(runId, WORKER_RESULT_FILE) };
    const mailbox = await this.#exchange.prepareTurn({ runId, turnId, context: toolContext });

    const executable = await this.#resolver(profile.executable, this.#sourceEnv);
    const args = expandProfileArgs(profile.args, {
      projectDir: projectRoot,
      contextFile: WORKER_CONTEXT_FILE,
      resultFile: WORKER_RESULT_FILE,
      runId,
    });
    const env = buildEnvironment(profile, this.#sourceEnv);
    env.PATCH_POLLER_RUN_ID = String(runId);
    let stdin = null;
    if (profile.inputMode === 'stdin-json') stdin = `${JSON.stringify(toolContext)}\n`;
    else if (profile.inputMode === 'stdin-text') stdin = `PATCH-POLLER CONTEXT\n${JSON.stringify(toolContext, null, 2)}\n`;

    const prepared = await this.#sandboxProvider.prepareExecution({
      executable,
      args,
      cwd: projectRoot,
      env,
      operation: `worker:${profile.name}`,
      sandbox: {
        required: true,
        projectDir: projectRoot,
        network: profile.sandbox.network,
        exposeConfiguredReadRoots: profile.sandbox.outsideProjectRead !== 'deny',
        ipc: mailbox.sandboxIpc(),
      },
    });
    if (!prepared?.evidence?.verified) {
      throw new PolicyError('worker execution refused because the configured OS isolation provider is not verified');
    }

    const child = spawn(
      prepared.executable,
      prepared.args,
      containedSpawnOptions({ cwd: prepared.cwd, env: prepared.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
    );
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

    const consumed = await consumeMailboxResult(mailbox);
    return {
      executable,
      args,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      outputTruncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      recovered: false,
      ...consumed,
      contextFile: mailbox.contextFile,
      resultFile: mailbox.resultFile,
      workerContextFile: mailbox.workerContextFile,
      workerResultFile: mailbox.workerResultFile,
      sandbox: prepared.evidence,
    };
  }
}
