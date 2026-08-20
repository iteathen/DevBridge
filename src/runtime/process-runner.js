import path from 'node:path';
import { PolicyError } from '../errors.js';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  assertRepositoryExecutionContract,
  normalizeRepositoryExecutionResult,
} from './repository-execution.js';
import { WORKER_CONTEXT_TRANSFER, WORKER_RESULT_TRANSFER } from './worker-exchange.js';

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function unwrapSingleJsonFence(text) {
  const match = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  return match ? match[1].trim() : text;
}

function abortedError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new PolicyError('worker execution aborted by the control plane');
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

export function toolBridge(runId) {
  return {
    protocol: 'devbridge/tool-bridge-v2',
    runId: String(runId),
    resultTransfer: WORKER_RESULT_TRANSFER,
    resultProtocol: 'devbridge/result-v1',
    requirement: 'Before exiting, emit exactly one JSON result envelope through the output transfer named result. The execution environment owns the transport endpoint. DevBridge independently validates the candidate; never claim completion unless the requested work and checks are complete.',
    gitAuthority: {
      owner: 'devbridge',
      rule: 'Project edits are proposals. Do not treat guest Git state as publication authority. DevBridge validates accepted candidate bytes, seals authoritative Git state, commits, and publishes on the trusted host.',
    },
    resultSchema: {
      required: ['protocol', 'status', 'summary'],
      protocol: 'devbridge/result-v1',
      status: ['complete', 'continue', 'blocked', 'failed'],
      summary: 'Required non-empty string, maximum 20000 characters.',
      progress: 'Optional array of at most 100 strings, each at most 4000 characters.',
      tests: 'Optional array of at most 100 bounded JSON values describing checks actually run.',
      nextStep: 'Optional string of at most 8000 characters or null.',
      blocker: 'Optional string of at most 8000 characters or null; use for a concrete blocked/failed cause.',
      checkpoint: 'Optional bounded JSON object for a proposal checkpoint; it is not human authorization.',
    },
    example: {
      protocol: 'devbridge/result-v1', status: 'complete', summary: 'Implemented and verified the requested change.',
      progress: [], tests: [], nextStep: null, blocker: null,
    },
  };
}

function executionArguments(args, runId) {
  return args.map((arg) => {
    if (arg === '{contextFile}') return { kind: 'input', name: WORKER_CONTEXT_TRANSFER };
    if (arg === '{resultFile}') return { kind: 'output', name: WORKER_RESULT_TRANSFER };
    if (arg.includes('{contextFile}') || arg.includes('{resultFile}')) {
      throw new PolicyError('worker transfer placeholders must occupy an entire argument');
    }
    return arg.replaceAll('{projectDir}', '.').replaceAll('{runId}', String(runId));
  });
}

function workerEnvironment(profile, runId) {
  return {
    ...profile.environment.set,
    CI: profile.environment.set.CI ?? '1',
    DEVBRIDGE_RUN_ID: String(runId),
    DEVBRIDGE_NONINTERACTIVE: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: profile.environment.set.NO_COLOR ?? '1',
  };
}

export class ProcessRunner {
  #exchange;
  #repositoryExecution;

  constructor({ workerExchange = null, repositoryExecution = null } = {}) {
    this.#exchange = workerExchange;
    this.#repositoryExecution = repositoryExecution == null ? null : assertRepositoryExecutionContract(repositoryExecution);
  }

  #turnIdentity(projectDir, runDir) {
    const projectRoot = path.resolve(projectDir);
    const resolvedRunDir = path.resolve(runDir);
    if (!isWithin(projectRoot, resolvedRunDir)) throw new PolicyError('run identity path must be inside the project directory');
    return { turnId: path.basename(resolvedRunDir) };
  }

  async recoverResult({ projectDir, runDir, runId }) {
    if (!this.#exchange) throw new PolicyError('worker recovery requires a control-plane-owned worker exchange');
    const { turnId } = this.#turnIdentity(projectDir, runDir);
    const mailbox = await this.#exchange.openTurn({ runId, turnId });
    const consumed = await consumeMailboxResult(mailbox);
    return {
      exitCode: null, signal: null, timedOut: false, aborted: false, outputTruncated: false,
      stdout: '', stderr: '', recovered: true, ...consumed,
      controlContextFile: mailbox.contextFile,
      controlResultFile: mailbox.resultFile,
      execution: null,
      processPriority: null,
    };
  }

  async run({ profile, projectDir, runDir, runId, repository = null, repositoryId = null, context, signal = null, onActivity = null }) {
    if (signal?.aborted) throw abortedError(signal);
    if (!this.#exchange) throw new PolicyError('worker execution requires a control-plane-owned worker exchange');
    if (!this.#repositoryExecution) throw new PolicyError('worker execution is unavailable because no repository execution implementation is configured');
    const status = this.#repositoryExecution.inspect();
    if (status.ready !== true) throw new PolicyError(`worker execution is unavailable: ${status.reason ?? 'repository execution is not ready'}`);
    const executionRepository = repository ?? context?.task?.targetRepository ?? null;
    if (typeof executionRepository !== 'string' || executionRepository.length === 0) throw new PolicyError('worker execution requires repository identity');

    const { turnId } = this.#turnIdentity(projectDir, runDir);
    const toolContext = { ...context, bridge: toolBridge(runId) };
    const mailbox = await this.#exchange.prepareTurn({ runId, turnId, context: toolContext });
    if (signal?.aborted) throw abortedError(signal);

    let stdin = null;
    if (profile.inputMode === 'stdin-json') stdin = `${JSON.stringify(toolContext)}\n`;
    else if (profile.inputMode === 'stdin-text') stdin = `DevBridge CONTEXT\n${JSON.stringify(toolContext, null, 2)}\n`;

    const executionResult = normalizeRepositoryExecutionResult(await this.#repositoryExecution.execute({
      protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
      operation: `worker:${profile.name ?? 'local-profile'}`,
      scope: { repository: executionRepository, repositoryId, runId },
      invocation: {
        tool: profile.name ?? 'local-profile',
        arguments: executionArguments(profile.args, runId),
        workingDirectory: '.',
      },
      environment: workerEnvironment(profile, runId),
      transfers: [mailbox.inputTransfer(), mailbox.outputTransfer({ maxBytes: 1_048_576 })],
      limits: { timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes },
      stdin,
      signal,
      onActivity,
    }));
    if (signal?.aborted) throw abortedError(signal);

    const consumed = await consumeMailboxResult(mailbox);
    return {
      exitCode: executionResult.exitCode,
      signal: executionResult.signal,
      timedOut: executionResult.timedOut,
      aborted: executionResult.aborted,
      outputTruncated: executionResult.outputTruncated,
      stdout: executionResult.stdout,
      stderr: executionResult.stderr,
      recovered: false,
      ...consumed,
      controlContextFile: mailbox.contextFile,
      controlResultFile: mailbox.resultFile,
      execution: {
        class: 'repository-code',
        location: 'repository',
        identity: executionResult.evidence.identity,
        scope: executionResult.evidence.scope,
      },
      processPriority: null,
    };
  }
}
