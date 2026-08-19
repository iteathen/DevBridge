import { ProtocolError } from '../errors.js';
import { redactText } from '../security/redaction.js';

const PROJECTION_PROTOCOL = 'patch-poller/tool-inventory-projection-v1';
const RECORD_PROTOCOL = 'patch-poller/tool-inventory-record-v1';
const SHA256_RE = /^[0-9a-f]{64}$/u;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError(`${name} must be a positive safe integer`);
  return value;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new ProtocolError('tool inventory projection requires a record object');
  if (record.protocol !== RECORD_PROTOCOL) throw new ProtocolError('tool inventory projection record protocol is invalid');
  if (typeof record.digest !== 'string' || !SHA256_RE.test(record.digest)) throw new ProtocolError('tool inventory projection digest is invalid');
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) throw new ProtocolError('tool inventory projection generation is invalid');
  if (!record.inventory || record.inventory.protocol !== 'patch-poller/tool-inventory-v1') throw new ProtocolError('tool inventory projection payload is invalid');
  return record;
}

function bodyFor(record) {
  const payload = {
    protocol: PROJECTION_PROTOCOL,
    digest: record.digest,
    generation: record.generation,
    inventory: record.inventory,
  };
  return [
    '<!-- patch-poller-tool-inventory -->',
    '## PATCH-POLLER — RUNNER CAPABILITIES',
    '',
    `Inventory generation ${record.generation}; digest \`${record.digest}\`.`,
    '',
    'This projection reports local authority; it does not grant tools or execution capability.',
    '',
    '```patch-poller-tool-inventory',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

export class ToolInventoryProjector {
  #client;
  #store;
  #queueRepository;
  #maxCommentBytes;
  #secrets;

  constructor({ client, stateStore, queueRepository, maxCommentBytes = 48_000, secretValues = [] }) {
    if (!client || typeof client.request !== 'function') throw new TypeError('ToolInventoryProjector requires a GitHub client');
    if (!stateStore || typeof stateStore.get !== 'function' || typeof stateStore.set !== 'function') throw new TypeError('ToolInventoryProjector requires a StateStore');
    if (typeof queueRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(queueRepository)) throw new ProtocolError('tool inventory queueRepository must be owner/name');
    if (!Number.isSafeInteger(maxCommentBytes) || maxCommentBytes < 4096) throw new ProtocolError('tool inventory maxCommentBytes must be >= 4096');
    this.#client = client;
    this.#store = stateStore;
    this.#queueRepository = queueRepository;
    this.#maxCommentBytes = maxCommentBytes;
    this.#secrets = secretValues;
  }

  #stateKey(issueNumber) {
    return `tool-inventory-projection.${this.#queueRepository}#${issueNumber}`;
  }

  async project({ issueNumber, record, critical = false }) {
    const issue = positiveInteger(issueNumber, 'tool inventory projection issueNumber');
    validateRecord(record);
    const rawBody = bodyFor(record);
    const body = redactText(rawBody, this.#secrets);
    if (body !== rawBody) {
      throw new ProtocolError('tool inventory projection contains a secret-bearing value; refusing to publish a redacted digest-bound payload');
    }
    if (Buffer.byteLength(body, 'utf8') > this.#maxCommentBytes) throw new RangeError('tool inventory projection exceeds configured GitHub comment budget');

    const key = this.#stateKey(issue);
    const previous = (await this.#store.get(key)) ?? {};
    if (previous.digest === record.digest && Number.isSafeInteger(previous.commentId)) {
      return { projected: false, reason: 'unchanged', digest: record.digest, commentId: previous.commentId };
    }

    const [owner, repo] = this.#queueRepository.split('/');
    let response = null;
    let commentId = Number.isSafeInteger(previous.commentId) ? previous.commentId : null;
    if (commentId) {
      try {
        response = await this.#client.request(
          'PATCH',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
          { body: { body }, critical },
        );
      } catch (error) {
        if (error?.status !== 404) throw error;
        commentId = null;
      }
    }
    if (!response) {
      // Deliberately do not search for/adopt marker-looking comments. The exact
      // PATCH-POLLER-owned comment ID is durable control state; repository or
      // user content cannot forge ownership merely by copying the marker/body.
      response = await this.#client.request(
        'POST',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/comments`,
        { body: { body }, critical },
      );
    }
    commentId = response.data?.id ?? commentId;
    if (!Number.isSafeInteger(commentId) || commentId < 1) throw new ProtocolError('GitHub tool inventory projection did not return a comment ID');
    await this.#store.set(key, {
      commentId,
      digest: record.digest,
      generation: record.generation,
      issueNumber: issue,
      projectedAt: new Date().toISOString(),
      ownership: 'control-state-comment-id',
    });
    return { projected: true, digest: record.digest, commentId };
  }
}
