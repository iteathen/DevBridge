import { ProtocolError } from '../errors.js';
import { assertSafeToolInventoryProjection } from '../runtime/tool-inventory.js';
import { redactText } from '../security/redaction.js';
import { headerValue } from './rate-budget.js';

const MARKER = '<!-- patch-poller-tool-inventory -->';

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError('tool inventory issue number must be a positive safe integer');
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

export function toolInventoryProjectionBody(inventory) {
  assertSafeToolInventoryProjection(inventory);
  return [
    MARKER,
    '## PATCH-POLLER — RUNNER TOOL INVENTORY',
    '',
    `Generation: \`${inventory.generation}\`  Digest: \`${inventory.digest}\``,
    '',
    '```patch-poller-tool-inventory',
    JSON.stringify(inventory, null, 2),
    '```',
  ].join('\n');
}

export function parseToolInventoryProjectionBody(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 256 * 1024) throw new ProtocolError('tool inventory projection body is not a bounded string');
  if (!body.includes(MARKER)) throw new ProtocolError('tool inventory projection marker is missing');
  const match = body.match(/```patch-poller-tool-inventory\r?\n([\s\S]*?)\r?\n```/u);
  if (!match) throw new ProtocolError('tool inventory projection fence is missing');
  let inventory;
  try { inventory = JSON.parse(match[1]); }
  catch (error) { throw new ProtocolError('tool inventory projection JSON is invalid', { cause: error }); }
  assertSafeToolInventoryProjection(inventory);
  return inventory;
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
      const comments = Array.isArray(last.data) ? last.data : [];
      found = comments.find((comment) => typeof comment?.body === 'string' && comment.body.includes(MARKER)) ?? null;
    }
    return found?.id ?? null;
  }

  async project({ issueNumber, inventory, critical = false }) {
    const issue = positiveInteger(issueNumber);
    assertSafeToolInventoryProjection(inventory);
    const rawBody = toolInventoryProjectionBody(inventory);
    const body = redactText(rawBody, this.#secrets);
    if (body !== rawBody) throw new ProtocolError('tool inventory projection required secret redaction; refusing to publish divergent authority data');
    if (Buffer.byteLength(body, 'utf8') > this.#maxCommentBytes) throw new RangeError('tool inventory projection exceeds configured GitHub comment budget');

    const key = this.#key(issue);
    const previous = (await this.#store.get(key)) ?? {};
    if (previous.digest === inventory.digest && previous.commentId) {
      return { projected: false, reason: 'unchanged', commentId: previous.commentId, digest: inventory.digest };
    }

    let commentId = previous.commentId ?? null;
    if (!commentId) commentId = await this.#findExisting(issue);
    const [owner, repo] = this.#queueRepository.split('/');
    let response;
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
    await this.#store.set(key, { commentId, digest: inventory.digest, issueNumber: issue, projectedAt: new Date().toISOString() });
    return { projected: true, commentId, digest: inventory.digest };
  }
}
