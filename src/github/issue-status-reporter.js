import { fitContextCapsule } from '../context/context-capsule.js';
import { redactText } from '../security/redaction.js';

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function renderBody({ runId, revision, stage, summary, capsule, sequence }) {
  return [
    `<!-- patch-poller-status run=${runId} revision=${revision} sequence=${sequence} -->`,
    `## PATCH-POLLER — ${stage}`,
    '',
    summary,
    '',
    '```patch-poller-context',
    JSON.stringify(capsule, null, 2),
    '```'
  ].join('\n');
}

export class IssueStatusReporter {
  #client;
  #stateStore;
  #queueRepository;
  #progressIntervalMs;
  #maxCommentBytes;
  #secrets;

  constructor({ client, stateStore, queueRepository, progressIntervalMs = 300_000, maxCommentBytes = 48_000, secretValues = [] }) {
    this.#client = client;
    this.#stateStore = stateStore;
    this.#queueRepository = queueRepository;
    this.#progressIntervalMs = progressIntervalMs;
    this.#maxCommentBytes = maxCommentBytes;
    this.#secrets = secretValues;
  }

  async publish({ issueNumber, runId, revision, stage, summary, capsule, terminal = false, force = false }) {
    const stateKey = `status.${this.#queueRepository}#${issueNumber}.${runId}`;
    const previous = (await this.#stateStore.get(stateKey)) ?? {};
    const now = Date.now();

    if (!terminal && !force && previous.publishedAt && now - previous.publishedAt < this.#progressIntervalMs && previous.stage === stage) {
      return { published: false, commentId: previous.commentId ?? null };
    }

    const sequence = (previous.sequence ?? 0) + 1;
    let fitted = fitContextCapsule(capsule, Math.max(4096, this.#maxCommentBytes - 4096));
    let body = renderBody({ runId, revision, stage, summary, capsule: fitted, sequence });
    body = redactText(body, this.#secrets);

    if (byteLength(body) > this.#maxCommentBytes) {
      fitted = fitContextCapsule(fitted, Math.max(2048, this.#maxCommentBytes - 8192));
      body = redactText(renderBody({ runId, revision, stage, summary: String(summary).slice(0, 2000), capsule: fitted, sequence }), this.#secrets);
    }

    if (byteLength(body) > this.#maxCommentBytes) {
      throw new RangeError('status report exceeds configured GitHub comment budget after compaction');
    }

    const [owner, repo] = this.#queueRepository.split('/');
    let response;
    if (previous.commentId) {
      response = await this.#client.request(
        'PATCH',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${previous.commentId}`,
        { body: { body }, critical: terminal }
      );
    } else {
      response = await this.#client.request(
        'POST',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
        { body: { body }, critical: terminal }
      );
    }

    const commentId = response.data?.id ?? previous.commentId ?? null;
    await this.#stateStore.set(stateKey, { commentId, stage, sequence, publishedAt: now });
    return { published: true, commentId, sequence };
  }
}
