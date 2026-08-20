import { PolicyError } from '../errors.js';
import { parseResultJsonText } from './result-json.js';

function abortedError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new PolicyError('work was cancelled');
}

function assertPorts(input, output, execute) {
  if (!input || typeof input.publish !== 'function') throw new TypeError('input port must provide publish()');
  if (!output || typeof output.consume !== 'function') throw new TypeError('output port must provide consume()');
  if (typeof execute !== 'function') throw new TypeError('execution port must be callable');
}

function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('execution observation must be an object');
  if (!Number.isSafeInteger(raw.exitCode) && raw.exitCode !== null) throw new TypeError('execution exitCode is invalid');
  for (const name of ['timedOut', 'aborted', 'outputTruncated']) if (typeof raw[name] !== 'boolean') throw new TypeError(`execution ${name} is invalid`);
  if (typeof raw.stdout !== 'string' || typeof raw.stderr !== 'string') throw new TypeError('execution output must be text');
  return {
    exitCode: raw.exitCode,
    signal: raw.signal == null ? null : String(raw.signal),
    timedOut: raw.timedOut,
    aborted: raw.aborted,
    outputTruncated: raw.outputTruncated,
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
}

async function consumeResult(output) {
  const consumed = await output.consume({ maxBytes: 1_048_576 });
  if (!consumed || typeof consumed !== 'object' || Array.isArray(consumed)) throw new TypeError('output observation is invalid');
  let result = null;
  let resultParseError = consumed.error ?? null;
  if (consumed.value != null && resultParseError == null) {
    try { result = parseResultJsonText(consumed.value); }
    catch (error) {
      if (error instanceof SyntaxError) resultParseError = error.message;
      else throw error;
    }
  }
  return { result, resultParseError, resultPresent: consumed.value != null };
}

export function workActions(identity) {
  return Object.freeze({
    protocol: 'devbridge/work-actions-v1',
    identity: String(identity),
    result: Object.freeze({
      protocol: 'devbridge/result-v1',
      requirement: 'Before exiting, emit exactly one JSON result through the provided result action. Candidate changes remain proposals until independently validated and accepted.',
      schema: Object.freeze({
        required: Object.freeze(['protocol', 'status', 'summary']),
        status: Object.freeze(['complete', 'continue', 'blocked', 'failed']),
        summary: 'Required non-empty string, maximum 20000 characters.',
        progress: 'Optional array of at most 100 strings, each at most 4000 characters.',
        tests: 'Optional array of at most 100 bounded JSON values describing checks actually run.',
        nextStep: 'Optional string of at most 8000 characters or null.',
        blocker: 'Optional string of at most 8000 characters or null.',
        checkpoint: 'Optional bounded JSON object; it is not human authorization.',
      }),
    }),
  });
}

function payloadFor(mode, context) {
  if (mode === 'stdin-json') return `${JSON.stringify(context)}\n`;
  if (mode === 'stdin-text') return `CONTEXT\n${JSON.stringify(context, null, 2)}\n`;
  return null;
}

export class WorkRunner {
  async recover({ output }) {
    if (!output || typeof output.consume !== 'function') throw new TypeError('recovery output port must provide consume()');
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
      stdout: '',
      stderr: '',
      recovered: true,
      ...(await consumeResult(output)),
    };
  }

  async run({ profile, identity, context, input, output, execute, signal = null, onActivity = null }) {
    if (signal?.aborted) throw abortedError(signal);
    assertPorts(input, output, execute);
    const actionContext = { ...context, actions: workActions(identity) };
    await input.publish(actionContext);
    if (signal?.aborted) throw abortedError(signal);
    const observation = normalizeObservation(await execute({
      name: profile.name ?? 'local-action',
      arguments: [...profile.args],
      environment: {
        ...profile.environment.set,
        CI: profile.environment.set.CI ?? '1',
        WORK_ID: String(identity),
        NONINTERACTIVE: '1',
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: profile.environment.set.NO_COLOR ?? '1',
      },
      limits: { timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes },
      payload: payloadFor(profile.inputMode, actionContext),
      signal,
      onActivity,
    }));
    if (signal?.aborted) throw abortedError(signal);
    return { ...observation, recovered: false, ...(await consumeResult(output)) };
  }
}

export { parseResultJsonText } from './result-json.js';
