import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { expandProfileArgs } from './cli-profile.js';
import { ControlMailboxStore } from './control-mailbox.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';
import { EXECUTION_CLASS_REPOSITORY } from './sandbox-manager.js';

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

export function toolBridge(runId, resultFile, { mailboxId = null, turn = null } = {}) {
  return {
    protocol: 'patch-poller/tool-bridge-v1',
    runId: String(runId),
    turn,
    mailboxId,
    resultFile,
    resultProtocol: 'patch-poller/result-v1',
    requirement: 'Before exiting, write one JSON result envelope to resultFile when the CLI can do so. PATCH-POLLER independently validates the workspace; never claim completion unless the requested work and checks are complete.',
    gitAuthority: {
      owner: 'patch-poller',
      rule: 'Project edits are proposals. Do not stage, commit, reset, checkout, clean, push, or otherwise write Git administrative state. The worker sandbox hides authoritative .git/admin state. Leave accepted project edits in the working tree; PATCH-POLLER validates, stages, seals, commits, and publishes them.'
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
  #mailboxes;
  #sandbox;
  #allowUncontainedTools;

  constructor({
    executableResolver = resolveExecutable,
    sourceEnv = process.env,
    mailboxStore = null,
    mailboxRoot = path.join(os.tmpdir(), 'patch-poller-control-mailboxes'),
    sandboxManager = null,
    allowUncontainedTools = false,
  } = {}) {
    this.#resolver = executableResolver;
    this.#sourceEnv = sourceEnv;
    this.#mailboxes = mailboxStore ?? new ControlMailboxStore({ root: path.resolve(mailboxRoot) });
    this.#sandbox = sandboxManager;
    this.#allowUncontainedTools = allowUncontainedTools === true;
  }

  async run({ profile, projectDir, runId, turn = 1, context }) {
    const projectRoot = path.resolve(projectDir);
    const mailbox = await this.#mailboxes.create({ runId, turn });
    const toolContext = {
      ...context,
      bridge: toolBridge(runId, mailbox.resultFile, { mailboxId: mailbox.mailboxId, turn }),
    };
    await this.#mailboxes.writeContext(mailbox, toolContext);

    const executable = await this.#resolver(profile.executable, this.#sourceEnv);
    const args = expandProfileArgs(profile.args, {
      projectDir: projectRoot,
      contextFile: mailbox.contextFile,
      resultFile: mailbox.resultFile,
      runId,
    });
    const env = buildEnvironment(profile, this.#sourceEnv);
    env.PATCH_POLLER_RUN_ID = String(runId);
    env.PATCH_POLLER_TURN = String(turn);
    env.PATCH_POLLER_MAILBOX_ID = mailbox.mailboxId;
    let stdin = null;
    if (profile.inputMode === 'stdin-json') stdin = `${JSON.stringify(toolContext)}\n`;
    else if (profile.inputMode === 'stdin-text') stdin = `PATCH-POLLER CONTEXT\n${JSON.stringify(toolContext, null, 2)}\n`;

    let launch;
    if (profile.controlOwned === true) {
      launch = {
        executable,
        args,
        cwd: projectRoot,
        env,
        sandbox: { provider: 'control-owned', configured: true, verified: false, controlOwned: true },
      };
    } else if (this.#sandbox) {
      launch = await this.#sandbox.prepareLaunch({
        executionClass: EXECUTION_CLASS_REPOSITORY,
        executable,
        args,
        cwd: projectRoot,
        env,
        projectDir: projectRoot,
        projectWrite: true,
        readOnlyRoots: [...(profile.sandbox.readOnlyRoots ?? []), mailbox.inputDir],
        writableRoots: [mailbox.outputDir],
        allowUnsafeUncontained: profile.sandbox.enforcement === 'none' && this.#allowUncontainedTools,
      });
    } else if (profile.sandbox.enforcement === 'none' && this.#allowUncontainedTools) {
      launch = {
        executable,
        args,
        cwd: projectRoot,
        env,
        sandbox: { provider: 'none', configured: false, verified: false, unsafeOverride: true },
      };
    } else {
      await this.#mailboxes.remove(mailbox);
      throw new PolicyError('proposal worker execution requires a verified sandbox provider');
    }

    let child;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let timedOut = false;
    let exit = { code: null, signal: null };
    let result = null;
    let resultParseError = null;

    try {
      child = spawn(launch.executable, launch.args, containedSpawnOptions({ cwd: launch.cwd, env: launch.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
      child.stdout.on('data', (chunk) => { const next = appendTail(stdout, chunk, profile.maxOutputBytes); stdout = next.buffer; outputTruncated ||= next.truncated; });
      child.stderr.on('data', (chunk) => { const next = appendTail(stderr, chunk, profile.maxOutputBytes); stderr = next.buffer; outputTruncated ||= next.truncated; });
      if (stdin != null) child.stdin.end(stdin); else child.stdin.end();

      let termination = null;
      const timer = setTimeout(() => { timedOut = true; termination = terminateProcessTree(child); }, profile.timeoutMs);
      timer.unref?.();
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      }).finally(async () => {
        clearTimeout(timer);
        if (termination) await termination;
      });

      const resultText = await this.#mailboxes.readResult(mailbox, { maxBytes: 1_048_576 });
      if (resultText != null) {
        try { result = parseResultJsonText(resultText); }
        catch (error) {
          if (error instanceof SyntaxError) resultParseError = error.message;
          else throw error;
        }
      }
    } finally {
      await this.#mailboxes.remove(mailbox);
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
      contextFile: null,
      resultFile: null,
      mailboxId: mailbox.mailboxId,
      sandbox: launch.sandbox,
    };
  }
}
