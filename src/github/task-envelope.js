import { createHash } from 'node:crypto';
import { ProtocolError } from '../errors.js';
import { normalizeControllerPlan } from '../run/controller-plan.js';
import { contentSha256 } from './content-provenance.js';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_BODY_BYTES = 96_000;
const MAX_INSTRUCTION_BYTES = 48_000;
const MAX_CONTEXT_BYTES = 32_000;
const MAX_HANDOFF_BYTES = 16_000;

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function stableEnvelope(value) {
  return JSON.stringify(value);
}

export function parseTaskEnvelope(body) {
  if (typeof body !== 'string') throw new ProtocolError('issue body must be a string');
  if (byteLength(body) > MAX_BODY_BYTES) throw new ProtocolError('issue body is too large');

  const matches = [...body.matchAll(/```patch-poller-task\s*\r?\n([\s\S]*?)\r?\n```/g)];
  if (matches.length !== 1) throw new ProtocolError('issue body must contain exactly one patch-poller-task block');

  let envelope;
  try {
    envelope = JSON.parse(matches[0][1]);
  } catch (error) {
    throw new ProtocolError('task envelope is not valid JSON', { cause: error });
  }

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new ProtocolError('task envelope must be an object');
  if (envelope.protocol !== 'patch-poller/task-v1') throw new ProtocolError('unsupported task protocol');
  if (!envelope.target || typeof envelope.target !== 'object' || !REPOSITORY_RE.test(envelope.target.repository ?? '')) {
    throw new ProtocolError('target.repository must be owner/name');
  }
  if (typeof envelope.instructions !== 'string' || envelope.instructions.trim() === '') {
    throw new ProtocolError('instructions must be a non-empty string');
  }
  if (byteLength(envelope.instructions) > MAX_INSTRUCTION_BYTES) throw new ProtocolError('instructions exceed task limit');

  if (envelope.context != null) {
    if (typeof envelope.context !== 'object' || Array.isArray(envelope.context)) throw new ProtocolError('context must be an object');
    if (byteLength(JSON.stringify(envelope.context)) > MAX_CONTEXT_BYTES) throw new ProtocolError('context exceeds task limit');
    if (envelope.context.handoff != null) {
      if (typeof envelope.context.handoff !== 'string') throw new ProtocolError('context.handoff must be a string');
      if (byteLength(envelope.context.handoff) > MAX_HANDOFF_BYTES) throw new ProtocolError('context.handoff exceeds handoff limit');
    }
  }

  if (envelope.requestedCapabilities != null && (!Array.isArray(envelope.requestedCapabilities) || envelope.requestedCapabilities.some((entry) => typeof entry !== 'string'))) {
    throw new ProtocolError('requestedCapabilities must be an array of strings');
  }

  if (envelope.preferredTool != null && !/^[A-Za-z0-9_.-]+$/.test(envelope.preferredTool)) {
    throw new ProtocolError('preferredTool must be a safe local profile name');
  }

  for (const forbidden of ['command', 'shell', 'cwd', 'localPath', 'executable', 'environment', 'credentials']) {
    if (Object.hasOwn(envelope, forbidden)) throw new ProtocolError(`remote task field ${forbidden} is forbidden`);
  }

  const controllerPlan = envelope.controllerPlan == null ? null : normalizeControllerPlan(envelope.controllerPlan);
  if (controllerPlan && envelope.preferredTool != null) {
    throw new ProtocolError('controller-plan tasks cannot also select a preferred coding tool');
  }

  const normalized = {
    protocol: envelope.protocol,
    target: { repository: envelope.target.repository },
    instructions: envelope.instructions,
    requestedCapabilities: envelope.requestedCapabilities ?? [],
    preferredTool: envelope.preferredTool ?? null,
    controllerPlan,
    context: envelope.context ?? null
  };
  const bodySha256 = contentSha256(body);

  return {
    envelope: normalized,
    contentSha256: bodySha256,
    revision: createHash('sha256')
      .update(stableEnvelope({ contentSha256: bodySha256, envelope: normalized }))
      .digest('hex')
  };
}
