import { ProtocolError } from '../errors.js';
import { redactText } from '../security/redaction.js';
import { headerValue } from './rate-budget.js';

const MARKER = '<!-- patch-poller-tool-inventory -->';

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError(`${name} must be a positive safe integer`);
  return value;
}

function lastPage(headers) {
  const link = headerValue(headers, 'link');
  if (!link) return 1;
  for (const part of String(link).split(',')) {
    if (!/rel="last"/u.test(part)) continue;
    const match = part.match(/[?&]page=(\d+)/u);
    if (match) return Number.parseInt(match[1], 10);
  }
  return 1;
}

function bodyFor(record) {
  return [
    MARKER,
    '## PATCH-POLLER — RUNNER CAPABILITIES',
    '',
    `Inventory generation ${record.generation}; digest \`${record.digest}\`.`,
    '',
    '```patch-poller-tool-inventory',
    JSON.stringify(record, null, 2),
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
    this.#client = client;
    this.#store = stateStore;
    this.#queueRepository = queueRepository;
    this.#maxCommentBytes = maxCommentBytes;
    this.#secrets = secretValues;
  }

  #key(issueNumber) { return `tool-inventory-projection.${this.#queueRepository}#${issueNumber}`; }

  async #findExisting(issueNumber) {
    const [owner, repo] = this.#queueRepository.split('/');
    const requestPath = (page) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
    const first = await this.#client.request('GET', requestPath(1));
    const firstComments = Array.isArray(first.data) ? first.data : [];
    let found = firstComments.find((comment) => typeof comment?.body === 'string' && comment.body.includes(MARKER)) ?? null;
    const page = lastPage(first.headers);
    if (!found && page > 1) {
      const last = await this.#client.request('GET', requestPath(page));
      found = (Array.isArray(last.data) ? last.data : []).find((comment) => typeof comment?.body === 'string' && comment.body.includes(MARKER)) ?? null;
    }
    return found?.id ?? null;
  }

  async project({ issueNumber, record, critical = false }) {
    const issue = positiveInteger(issueNumber, 'tool inventory projection issueNumber');
    if (!record || record.protocol !== 'patch-poller/tool-inventory-record-v1' || typeof record.digest !== 'string') {
      throw new ProtocolError('tool inventory projection requires a normalized inventory record');
    }
    const rawBody = bodyFor(record);
    const body = redactText(rawBody, this.#secrets);
    if (Buffer.byteLength(body, 'utf8') > this.#maxCommentBytes) throw new RangeError('tool inventory projection exceeds configured GitHub comment budget');
    const key = this.#key(issue);
    const previous = (await this.#store.get(key)) ?? {};
    if (previous.digest === record.digest && previous.commentId) {
      return { projected: false, reason: 'unchanged', digest: record.digest, commentId: previous.commentId };
    }

    const [owner, repo] = this.#queueRepository.split('/');
    let commentId = previous.commentId ?? await this.#findExisting(issue);
    let response = null;
    if (commentId) {
      try {
        response = await this.#client.request('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`, { body: { body }, critical });
      } catch (error) {
        if (error?.status !== 404) throw error;
        commentId = null;
      }
    }
    if (!response) {
      response = await this.#client.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/comments`, { body: { body }, critical });
    }
    commentId = response.data?.id ?? commentId;
    if (!Number.isSafeInteger(commentId) || commentId < 1) throw new ProtocolError('GitHub tool inventory projection did not return a comment ID');
    await this.#store.set(key, { digest: record.digest, generation: record.generation, commentId, projectedAt: new Date().toISOString() });
    return { projected: true, digest: record.digest, commentId };
  }
}
