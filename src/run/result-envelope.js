import { ProtocolError } from '../errors.js';

const STATUSES = new Set(['complete', 'continue', 'blocked', 'failed']);

function boundedString(value, name, max = 20_000, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || (required && value.trim() === '') || value.length > max) {
    throw new ProtocolError(`${name} must be ${required ? 'a non-empty ' : 'a '}string <= ${max} characters`);
  }
  return value;
}

function tail(value, max = 4000) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(-max);
}

function serializedSize(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text.length : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function toolFailure(summary, blocker) {
  return {
    protocol: 'patch-poller/result-v1',
    status: 'failed',
    summary,
    progress: [],
    tests: [],
    nextStep: null,
    blocker,
    checkpoint: null,
    inferred: true
  };
}

function protocolFailure(detail) {
  return toolFailure(
    `Local coding tool produced an invalid patch-poller/result-v1 envelope: ${tail(detail)}`,
    'tool-protocol'
  );
}

function parseStructuredResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProtocolError('tool result must be an object');
  if (raw.protocol !== 'patch-poller/result-v1') throw new ProtocolError('tool result protocol must be patch-poller/result-v1');
  if (!STATUSES.has(raw.status)) throw new ProtocolError('tool result status is invalid');

  const progress = raw.progress ?? [];
  if (!Array.isArray(progress) || progress.length > 100 || progress.some((entry) => typeof entry !== 'string' || entry.length > 4000)) {
    throw new ProtocolError('tool result progress must be <= 100 bounded strings');
  }
  const tests = raw.tests ?? [];
  if (!Array.isArray(tests) || tests.length > 100 || tests.some((entry) => serializedSize(entry) > 8000)) {
    throw new ProtocolError('tool result tests must be <= 100 bounded JSON entries');
  }

  let checkpoint = null;
  if (raw.checkpoint != null) {
    if (!raw.checkpoint || typeof raw.checkpoint !== 'object' || Array.isArray(raw.checkpoint) || serializedSize(raw.checkpoint) > 32_000) {
      throw new ProtocolError('tool result checkpoint must be a bounded JSON object');
    }
    checkpoint = structuredClone(raw.checkpoint);
  }

  return {
    protocol: raw.protocol,
    status: raw.status,
    summary: boundedString(raw.summary, 'tool result summary', 20_000, true),
    progress: [...progress],
    tests: structuredClone(tests),
    nextStep: boundedString(raw.nextStep, 'tool result nextStep', 8000),
    blocker: boundedString(raw.blocker, 'tool result blocker', 8000),
    checkpoint,
    inferred: false
  };
}

export function parseToolResult(raw, {
  exitCode = 0,
  timedOut = false,
  resultParseError = null,
  stdout = '',
  stderr = ''
} = {}) {
  if (timedOut) return toolFailure('Local coding tool timed out.', 'tool-timeout');
  if (resultParseError) return protocolFailure(`malformed JSON/result file: ${resultParseError}`);
  if (exitCode !== 0) {
    return toolFailure(
      `Local coding tool exited with code ${exitCode}. ${tail(stderr || stdout)}`.trim(),
      'tool-exit'
    );
  }
  if (raw == null) {
    return {
      protocol: 'patch-poller/result-v1',
      status: 'complete',
      summary: `Local coding tool exited successfully without a structured result.${stdout ? ` Output tail: ${tail(stdout)}` : ''}`,
      progress: [],
      tests: [],
      nextStep: null,
      blocker: null,
      checkpoint: null,
      inferred: true
    };
  }

  try {
    return parseStructuredResult(raw);
  } catch (error) {
    if (error instanceof ProtocolError) return protocolFailure(error.message);
    throw error;
  }
}
