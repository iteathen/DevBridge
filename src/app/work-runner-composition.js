import path from 'node:path';
import { PolicyError } from '../errors.js';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  assertRepositoryExecutionContract,
  normalizeRepositoryExecutionResult,
} from '../runtime/repository-execution.js';
import { extractResultEmission } from '../runtime/result-emission.js';
import { WorkRunner } from '../runtime/work-runner.js';
import { WORKER_CONTEXT_TRANSFER, WORKER_RESULT_TRANSFER } from '../runtime/worker-exchange.js';

const RESULT_LIMIT = 1_048_576;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function turnIdentity(projectDir, runDir) {
  const root = path.resolve(projectDir);
  const candidate = path.resolve(runDir);
  if (!isWithin(root, candidate)) throw new PolicyError('run identity path must be inside the project directory');
  return path.basename(candidate);
}

function executionArguments(args, identity) {
  return args.map((argument) => {
    if (argument === '{contextFile}') return { kind: 'input', name: WORKER_CONTEXT_TRANSFER };
    if (argument === '{resultFile}') return { kind: 'output', name: WORKER_RESULT_TRANSFER };
    if (argument.includes('{contextFile}') || argument.includes('{resultFile}')) throw new PolicyError('transfer placeholders must occupy an entire argument');
    return argument.replaceAll('{projectDir}', '.').replaceAll('{runId}', String(identity));
  });
}

function usesTransfer(argumentsList, kind, name) {
  return argumentsList.some((argument) => argument && typeof argument === 'object' && argument.kind === kind && argument.name === name);
}

function outputPort(mailbox) {
  return {
    async consume({ maxBytes }) {
      const observed = await mailbox().consumeResult({ maxBytes });
      return { value: observed.text, error: observed.resultParseError };
    },
  };
}

export function composeWorkRunner({ mailboxStore, activeExecution }) {
  if (!mailboxStore || typeof mailboxStore.prepareTurn !== 'function' || typeof mailboxStore.openTurn !== 'function') throw new TypeError('mailbox store contract is incomplete');
  const execution = assertRepositoryExecutionContract(activeExecution);
  const runner = new WorkRunner();
  return Object.freeze({
    async recoverResult({ projectDir, runDir, runId }) {
      const mailbox = await mailboxStore.openTurn({ runId, turnId: turnIdentity(projectDir, runDir) });
      return runner.recover({ output: outputPort(() => mailbox) });
    },
    async run({ profile, projectDir, runDir, runId, repository = null, repositoryId = null, context, signal = null, onActivity = null }) {
      const status = execution.inspect();
      if (status.ready !== true) throw new PolicyError(`work execution is unavailable: ${status.reason ?? 'execution is not ready'}`);
      const target = repository ?? context?.task?.targetRepository ?? null;
      if (typeof target !== 'string' || target.length === 0) throw new PolicyError('work execution requires an admitted target identity');
      const turnId = turnIdentity(projectDir, runDir);
      let mailbox = null;
      const input = {
        async publish(value) { mailbox = await mailboxStore.prepareTurn({ runId, turnId, context: value }); },
      };
      const output = outputPort(() => {
        if (!mailbox) throw new PolicyError('output is unavailable before input publication');
        return mailbox;
      });
      const execute = async (request) => {
        if (!mailbox) throw new PolicyError('execution is unavailable before input publication');
        const invocationArguments = executionArguments(request.arguments, runId);
        const resultTransfer = mailbox.outputTransfer({ maxBytes: RESULT_LIMIT });
        const transfers = [mailbox.inputTransfer()];
        if (usesTransfer(invocationArguments, 'output', WORKER_RESULT_TRANSFER)) transfers.push(resultTransfer);
        const observed = normalizeRepositoryExecutionResult(await execution.execute({
          protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
          operation: `work:${request.name}`,
          scope: { repository: target, repositoryId, runId },
          invocation: {
            tool: request.name,
            arguments: invocationArguments,
            workingDirectory: '.',
          },
          environment: request.environment,
          transfers,
          limits: request.limits,
          stdin: request.payload,
          signal: request.signal,
          onActivity: request.onActivity,
        }));
        const emitted = extractResultEmission(observed.stdout);
        if (emitted.text != null) {
          const existing = await mailbox.consumeResult({ maxBytes: RESULT_LIMIT });
          if (existing.resultParseError != null || existing.text != null) {
            throw new PolicyError('work produced results through both the explicit output action and stdout emission');
          }
          await resultTransfer.port.write(`${emitted.text}\n`);
        }
        return { ...observed, stdout: emitted.output };
      };
      return runner.run({ profile, identity: runId, context, input, output, execute, signal, onActivity });
    },
  });
}
