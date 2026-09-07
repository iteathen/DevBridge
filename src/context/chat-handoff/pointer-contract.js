import { createHash } from 'node:crypto';

const POINTER_PROTOCOL = 'devbridge/chat-handoff-pointer-v1';

export function createChatHandoffPointerContract({ createError, normalizeText, normalizeDigest, normalizeSequence, normalizeIdentifier, normalizeTimestamp }) {
  if (![createError, normalizeText, normalizeDigest, normalizeSequence, normalizeIdentifier, normalizeTimestamp].every((value) => typeof value === 'function')) throw new TypeError('pointer contract requires complete local ports');
  const fail = (message) => { throw createError(message); };

  function closedObject(input, allowed, name) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${name} must be an object`);
    for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${name}.${key} is not allowed`);
    return input;
  }

  function normalizeRef(ref, name) {
    if (ref == null) return null;
    const item = closedObject(ref, new Set(['key', 'digest', 'sequence', 'handoffId']), name);
    return {
      key: normalizeText(item.key, `${name}.key`, 300),
      digest: normalizeDigest(item.digest, `${name}.digest`),
      sequence: normalizeSequence(item.sequence, `${name}.sequence`),
      handoffId: normalizeIdentifier(item.handoffId, `${name}.handoffId`),
    };
  }

  function verify(input) {
    if (input == null) return null;
    const value = closedObject(input, new Set(['protocol', 'current', 'previous', 'updatedAt']), 'chat handoff pointer');
    if (value.protocol !== POINTER_PROTOCOL) fail('chat handoff pointer protocol is invalid');
    return {
      protocol: POINTER_PROTOCOL,
      current: normalizeRef(value.current, 'chat handoff pointer current'),
      previous: normalizeRef(value.previous, 'chat handoff pointer previous'),
      updatedAt: normalizeTimestamp(value.updatedAt, 'chat handoff pointer updatedAt'),
    };
  }

  function locate(subject) {
    const digest = createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 24);
    const prefix = `chat-handoff.${digest}`;
    return { pointer: `${prefix}.latest`, records: `${prefix}.record.` };
  }

  function reference(value) { return normalizeRef(value, 'chat handoff pointer current'); }
  function next({ current, previous, updatedAt }) { return verify({ protocol: POINTER_PROTOCOL, current, previous, updatedAt }); }

  return Object.freeze({ verify, locate, reference, next });
}
