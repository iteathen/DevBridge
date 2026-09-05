const RECORD_PROTOCOL = 'devbridge/chat-handoff-store-v1';

export function createChatHandoffRecordContract({ createError, normalizePayload, digestPayload, normalizeDigest, describePayload }) {
  if (![createError, normalizePayload, digestPayload, normalizeDigest, describePayload].every((value) => typeof value === 'function')) throw new TypeError('record contract requires complete local ports');
  const fail = (message) => { throw createError(message); };

  function closedObject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('chat handoff store record must be an object');
    const allowed = new Set(['protocol', 'state', 'digest', 'handoff', 'createdAt', 'verifiedAt']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`chat handoff store record.${key} is not allowed`);
    return input;
  }

  function verify(input, { expectedDigest = null, expectedState = null, maxBytes }) {
    const value = closedObject(input);
    if (value.protocol !== RECORD_PROTOCOL) fail('chat handoff store record protocol is invalid');
    if (!['planned', 'ready'].includes(value.state)) fail('chat handoff store record state is invalid');
    if (expectedState && value.state !== expectedState) fail(`chat handoff store record is ${value.state}, expected ${expectedState}`);
    const digest = normalizeDigest(value.digest, 'chat handoff store record digest');
    if (expectedDigest && digest !== expectedDigest) fail('chat handoff store record digest does not match expected digest');
    const handoff = normalizePayload(value.handoff, { maxBytes });
    if (digestPayload(handoff, { maxBytes }) !== digest) fail('chat handoff store record payload digest mismatch');
    return { ...value, digest, handoff };
  }

  function planned({ digest, handoff, createdAt }) {
    return { protocol: RECORD_PROTOCOL, state: 'planned', digest, handoff, createdAt, verifiedAt: null };
  }

  function ready(value, verifiedAt) { return { ...value, state: 'ready', verifiedAt }; }
  function order(value) { return value?.handoff ? describePayload(value.handoff).order ?? 0 : 0; }

  return Object.freeze({ verify, planned, ready, order });
}
