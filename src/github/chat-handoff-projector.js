import { createHash } from 'node:crypto';
import { ProtocolError } from '../errors.js';
import { chatHandoffDigest, normalizeChatHandoff } from '../context/chat-handoff.js';
import { redactText } from '../security/redaction.js';
import { headerValue } from './rate-budget.js';

const PROJECTION_PROTOCOL = 'patch-poller/chat-handoff-projection-v1';
const SEED_PROTOCOL = 'patch-poller/chat-resume-github-v1';
const SHA256_RE = /^[0-9a-f]{64}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const MAX_PROTOCOL_HANDOFF_BYTES = 256 * 1024;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError(`${name} must be a positive safe integer`);
  return value;
}

function repository(value, name = 'repository') {
  if (typeof value !== 'string' || !REPOSITORY_RE.test(value)) throw new ProtocolError(`${name} must be owner/name`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) throw new ProtocolError(`${name} must be a safe bounded identifier`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new ProtocolError(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function projectionSlot(mailboxRepository, issueNumber) {
  return createHash('sha256').update(`${mailboxRepository}#${issueNumber}`, 'utf8').digest('hex').slice(0, 24);
}

function marker(mailboxRepository, issueNumber) {
  return `<!-- patch-poller-chat-handoff slot=${projectionSlot(mailboxRepository, issueNumber)} -->`;
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

function projectionBody({ mailboxRepository, issueNumber, record, seed }) {
  return [
    marker(mailboxRepository, issueNumber),
    '## PATCH-POLLER — CHAT HANDOFF READY',
    '',
    seed,
    '',
    '```patch-poller-chat-handoff',
    JSON.stringify({
      protocol: PROJECTION_PROTOCOL,
      digest: record.digest,
      handoff: record.handoff,
    }, null, 2),
    '```',
  ].join('\n');
}

export function buildGitHubChatResumeSeed(recordOrHandoff, issueNumber, digestOverride = null, { mailboxRepository = null } = {}) {
  const handoff = recordOrHandoff?.handoff ?? recordOrHandoff;
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) throw new ProtocolError('GitHub chat resume seed requires a handoff object');
  const targetRepository = repository(handoff.repository, 'GitHub chat resume target repository');
  const mailbox = repository(mailboxRepository ?? targetRepository, 'GitHub chat resume mailbox repository');
  const handoffId = safeId(handoff.handoffId, 'GitHub chat resume handoffId');
  const sha256 = digest(digestOverride ?? recordOrHandoff?.digest, 'GitHub chat resume digest');
  const issue = positiveInteger(issueNumber, 'GitHub chat resume issueNumber');
  return `PATCH-POLLER-RESUME-GITHUB v1 mailbox=${mailbox} issue=${issue} repo=${targetRepository} handoff=${handoffId} sha256=${sha256}`;
}

export function parseGitHubChatResumeSeed(seed) {
  if (typeof seed !== 'string' || seed.length > 768) throw new ProtocolError('GitHub chat resume seed must be a bounded string');
  const match = seed.match(/^PATCH-POLLER-RESUME-GITHUB v1 mailbox=([^ ]+) issue=(\d+) repo=([^ ]+) handoff=([^ ]+) sha256=([0-9a-f]{64})$/u);
  if (!match) throw new ProtocolError('GitHub chat resume seed is malformed');
  return {
    protocol: SEED_PROTOCOL,
    mailboxRepository: repository(match[1], 'GitHub chat resume mailbox repository'),
    issueNumber: positiveInteger(Number.parseInt(match[2], 10), 'GitHub chat resume issueNumber'),
    repository: repository(match[3], 'GitHub chat resume target repository'),
    handoffId: safeId(match[4], 'GitHub chat resume handoffId'),
    digest: digest(match[5], 'GitHub chat resume digest'),
  };
}

export function parseChatHandoffProjectionBody(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 300 * 1024) throw new ProtocolError('GitHub chat handoff projection body is not a bounded string');
  const fence = body.match(/```patch-poller-chat-handoff\r?\n([\s\S]*?)\r?\n```/u);
  if (!fence) throw new ProtocolError('GitHub chat handoff projection payload fence is missing');
  let payload;
  try { payload = JSON.parse(fence[1]); }
  catch (error) { throw new ProtocolError(`GitHub chat handoff projection payload is invalid JSON: ${error.message}`, { cause: error }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => !['protocol', 'digest', 'handoff'].includes(key))) {
    throw new ProtocolError('GitHub chat handoff projection payload schema is invalid');
  }
  if (payload.protocol !== PROJECTION_PROTOCOL) throw new ProtocolError('GitHub chat handoff projection protocol is invalid');
  const expectedDigest = digest(payload.digest, 'GitHub chat handoff projection digest');
  const handoff = normalizeChatHandoff(payload.handoff, { maxBytes: MAX_PROTOCOL_HANDOFF_BYTES });
  if (chatHandoffDigest(handoff, { maxBytes: MAX_PROTOCOL_HANDOFF_BYTES }) !== expectedDigest) {
    throw new ProtocolError('GitHub chat handoff projection payload digest mismatch');
  }
  const seedLine = body.split(/\r?\n/u).find((line) => line.startsWith('PATCH-POLLER-RESUME-GITHUB v1 '));
  if (!seedLine) throw new ProtocolError('GitHub chat handoff projection resume seed is missing');
  const seed = parseGitHubChatResumeSeed(seedLine);
  if (seed.repository !== handoff.repository || seed.handoffId !== handoff.handoffId || seed.digest !== expectedDigest) {
    throw new ProtocolError('GitHub chat handoff projection seed does not match the payload');
  }
  if (!body.includes(marker(seed.mailboxRepository, seed.issueNumber))) {
    throw new ProtocolError('GitHub chat handoff projection mailbox marker does not match the resume seed');
  }
  return { protocol: PROJECTION_PROTOCOL, digest: expectedDigest, handoff, seed };
}

export class ChatHandoffProjector {
  #client;
  #store;
  #queueRepository;
  #maxCommentBytes;
  #secrets;

  constructor({ client, stateStore, queueRepository, maxCommentBytes = 48_000, secretValues = [] }) {
    if (!client || typeof client.request !== 'function') throw new TypeError('ChatHandoffProjector requires a GitHub client');
    if (!stateStore || typeof stateStore.get !== 'function' || typeof stateStore.set !== 'function') throw new TypeError('ChatHandoffProjector requires a StateStore');
    this.#client = client;
    this.#store = stateStore;
    this.#queueRepository = repository(queueRepository, 'chat handoff projection mailbox repository');
    if (!Number.isSafeInteger(maxCommentBytes) || maxCommentBytes < 4096) throw new ProtocolError('chat handoff projection maxCommentBytes must be >= 4096');
    this.#maxCommentBytes = maxCommentBytes;
    this.#secrets = secretValues;
  }

  #stateKey(issueNumber) {
    return `chat-handoff-projection.${this.#queueRepository}#${issueNumber}`;
  }

  async #findExisting(issueNumber) {
    const [owner, repo] = this.#queueRepository.split('/');
    const requestPath = (page) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
    const wanted = marker(this.#queueRepository, issueNumber);
    const first = await this.#client.request('GET', requestPath(1));
    const comments = Array.isArray(first.data) ? first.data : [];
    let found = comments.find((comment) => typeof comment?.body === 'string' && comment.body.includes(wanted)) ?? null;
    const page = lastPage(first.headers);
    if (!found && page > 1) {
      const last = await this.#client.request('GET', requestPath(page));
      const latest = Array.isArray(last.data) ? last.data : [];
      found = latest.find((comment) => typeof comment?.body === 'string' && comment.body.includes(wanted)) ?? null;
    }
    return found?.id ?? null;
  }

  async project({ issueNumber, record, critical = false }) {
    const issue = positiveInteger(issueNumber, 'chat handoff projection issueNumber');
    if (!record || record.state !== 'ready' || !record.handoff) throw new ProtocolError('chat handoff projection requires a verified ready handoff record');
    repository(record.handoff.repository, 'chat handoff projection target repository');
    digest(record.digest, 'chat handoff projection digest');
    const seed = buildGitHubChatResumeSeed(record, issue, null, { mailboxRepository: this.#queueRepository });
    const rawBody = projectionBody({ mailboxRepository: this.#queueRepository, issueNumber: issue, record, seed });
    const body = redactText(rawBody, this.#secrets);
    if (body !== rawBody) {
      throw new ProtocolError('chat handoff projection requires redaction; refusing to publish a digest-divergent reconstruction payload');
    }
    if (Buffer.byteLength(body, 'utf8') > this.#maxCommentBytes) throw new RangeError('chat handoff projection exceeds configured GitHub comment budget');

    const key = this.#stateKey(issue);
    const previous = (await this.#store.get(key)) ?? {};
    if (previous.digest === record.digest && previous.commentId) {
      return { projected: false, reason: 'already-projected', commentId: previous.commentId, digest: record.digest, seed };
    }

    let commentId = previous.commentId ?? null;
    if (!commentId) commentId = await this.#findExisting(issue);
    const [owner, repo] = this.#queueRepository.split('/');
    let response;
    if (commentId) {
      try {
        response = await this.#client.request(
          'PATCH',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
          { body: { body }, critical }
        );
      } catch (error) {
        if (error?.status !== 404) throw error;
        commentId = await this.#findExisting(issue);
        if (commentId) {
          response = await this.#client.request(
            'PATCH',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
            { body: { body }, critical }
          );
        }
      }
    }
    if (!response) {
      response = await this.#client.request(
        'POST',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/comments`,
        { body: { body }, critical }
      );
    }
    commentId = response.data?.id ?? commentId;
    if (!Number.isSafeInteger(commentId) || commentId < 1) throw new ProtocolError('GitHub chat handoff projection did not return a comment ID');
    await this.#store.set(key, { commentId, digest: record.digest, issueNumber: issue, projectedAt: new Date().toISOString() });
    return { projected: true, commentId, digest: record.digest, seed };
  }
}
