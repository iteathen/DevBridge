import { ProtocolError } from '../errors.js';
import { contentSha256 } from './content-provenance.js';

const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/u;
const CHECKPOINT_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const ACTIONS = new Set(['approve', 'reject', 'redirect']);

export function parseDecisionEnvelope(body) {
  if (typeof body !== 'string') throw new ProtocolError('decision body must be a string');
  if (Buffer.byteLength(body, 'utf8') > 64_000) throw new ProtocolError('decision body is too large');

  const matches = [...body.matchAll(/```patch-poller-decision\s*\r?\n([\s\S]*?)\r?\n```/gu)];
  if (matches.length !== 1) throw new ProtocolError('decision must contain exactly one patch-poller-decision block');

  let value;
  try {
    value = JSON.parse(matches[0][1]);
  } catch (error) {
    throw new ProtocolError('decision envelope is not valid JSON', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('decision envelope must be an object');

  const allowed = new Set(['protocol', 'runId', 'taskRevision', 'checkpointId', 'subjectDigest', 'action', 'instructions']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ProtocolError(`decision field ${key} is not supported`);
  }
  if (value.protocol !== 'patch-poller/decision-v1') throw new ProtocolError('unsupported decision protocol');
  if (!RUN_ID_RE.test(value.runId ?? '')) throw new ProtocolError('decision runId is invalid');
  if (!DIGEST_RE.test(value.taskRevision ?? '')) throw new ProtocolError('decision taskRevision is invalid');
  if (!CHECKPOINT_ID_RE.test(value.checkpointId ?? '')) throw new ProtocolError('decision checkpointId is invalid');
  if (!DIGEST_RE.test(value.subjectDigest ?? '')) throw new ProtocolError('decision subjectDigest is invalid');
  if (!ACTIONS.has(value.action)) throw new ProtocolError('decision action must be approve, reject, or redirect');

  if (value.action === 'redirect' && (typeof value.instructions !== 'string' || value.instructions.trim() === '')) {
    throw new ProtocolError('redirect decision requires instructions');
  }
  if (value.instructions != null && (typeof value.instructions !== 'string' || Buffer.byteLength(value.instructions, 'utf8') > 32_000)) {
    throw new ProtocolError('decision instructions are invalid or too large');
  }

  return {
    protocol: value.protocol,
    runId: value.runId,
    taskRevision: value.taskRevision,
    checkpointId: value.checkpointId,
    subjectDigest: value.subjectDigest,
    action: value.action,
    instructions: value.instructions ?? null,
    contentSha256: contentSha256(body),
  };
}
