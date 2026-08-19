import { ProtocolError } from '../errors.js';
import { contentSha256 } from './content-provenance.js';

const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const REVISION_RE = /^[0-9a-f]{64}$/;

export function parseFeedbackEnvelope(body) {
  if (typeof body !== 'string') throw new ProtocolError('feedback body must be a string');
  const matches = [...body.matchAll(/```devbridge-feedback\s*\r?\n([\s\S]*?)\r?\n```/g)];
  if (matches.length !== 1) throw new ProtocolError('feedback must contain exactly one devbridge-feedback block');

  let value;
  try {
    value = JSON.parse(matches[0][1]);
  } catch (error) {
    throw new ProtocolError('feedback envelope is not valid JSON', { cause: error });
  }

  if (value?.protocol !== 'devbridge/feedback-v1') throw new ProtocolError('unsupported feedback protocol');
  if (!RUN_ID_RE.test(value.runId ?? '')) throw new ProtocolError('feedback runId is invalid');
  if (!REVISION_RE.test(value.taskRevision ?? '')) throw new ProtocolError('feedback taskRevision is invalid');
  if (!['continue', 'cancel'].includes(value.action)) throw new ProtocolError('feedback action must be continue or cancel');
  if (value.action === 'continue' && (typeof value.instructions !== 'string' || value.instructions.trim() === '')) {
    throw new ProtocolError('continue feedback requires instructions');
  }
  if (value.instructions != null && (typeof value.instructions !== 'string' || Buffer.byteLength(value.instructions, 'utf8') > 32_000)) {
    throw new ProtocolError('feedback instructions are invalid or too large');
  }

  return {
    protocol: value.protocol,
    runId: value.runId,
    taskRevision: value.taskRevision,
    action: value.action,
    instructions: value.instructions ?? null,
    contentSha256: contentSha256(body)
  };
}
