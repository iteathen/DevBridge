import { createHash } from 'node:crypto';
import { parseTaskEnvelope } from './task-envelope.js';

function contentDigest(body) {
  return createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex');
}

function containsAuthorityBlock(body) {
  return typeof body === 'string' && body.includes('```patch-poller-task');
}

function isUnedited(comment) {
  return typeof comment?.created_at === 'string' && comment.created_at !== '' && comment.updated_at === comment.created_at;
}

export class IssueTaskSource {
  #client;
  #queueRepository;
  #taskLabel;
  #trustedActorIds;
  #maxTasks;

  constructor({ client, queueRepository, taskLabel, trustedActorIds, maxTasks = 30 }) {
    this.#client = client;
    this.#queueRepository = queueRepository;
    this.#taskLabel = taskLabel;
    this.#trustedActorIds = new Set(trustedActorIds.map(String));
    this.#maxTasks = maxTasks;
  }

  async #comments(owner, repo, issueNumber) {
    const response = await this.#client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`,
      { conditional: true }
    );
    if (response.notModified) return [];
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issue comments response must be an array');
    return response.data;
  }

  async poll() {
    const [owner, repo] = this.#queueRepository.split('/');
    const query = new URLSearchParams({
      state: 'open',
      labels: this.#taskLabel,
      per_page: String(this.#maxTasks),
      sort: 'created',
      direction: 'asc'
    });
    const response = await this.#client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${query}`,
      { conditional: true }
    );

    if (response.notModified) return { tasks: [], unchanged: true, pollIntervalMs: this.#client.rateBudget.snapshot().pollIntervalMs };
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issues response must be an array');

    const tasks = [];
    const rejected = [];
    for (const issue of response.data) {
      if (issue?.pull_request) continue;
      const comments = await this.#comments(owner, repo, issue.number);
      let selected = null;

      for (const comment of comments) {
        if (!containsAuthorityBlock(comment?.body)) continue;
        const actorId = String(comment?.user?.id ?? '');
        const commentId = Number(comment?.id ?? 0) || null;
        if (!this.#trustedActorIds.has(actorId)) {
          rejected.push({ issueNumber: issue.number, commentId, reason: 'untrusted-actor', actorId });
          continue;
        }
        if (!isUnedited(comment)) {
          rejected.push({ issueNumber: issue.number, commentId, reason: 'edited-authority-content', actorId, contentSha256: contentDigest(comment?.body) });
          continue;
        }
        try {
          const parsed = parseTaskEnvelope(comment.body ?? '');
          selected = {
            queueRepository: this.#queueRepository,
            issueNumber: issue.number,
            issueId: String(issue.id),
            actorId,
            actorLogin: comment.user?.login ?? null,
            title: issue.title ?? '',
            updatedAt: comment.updated_at,
            envelope: parsed.envelope,
            revision: parsed.revision,
            authority: {
              source: 'github-comment',
              commentId,
              actorId,
              createdAt: comment.created_at,
              updatedAt: comment.updated_at,
              contentSha256: contentDigest(comment.body),
              unedited: true,
            },
          };
        } catch (error) {
          rejected.push({ issueNumber: issue.number, commentId, reason: 'invalid-envelope', detail: error.message, contentSha256: contentDigest(comment?.body) });
        }
      }
      if (selected) tasks.push(selected);
    }

    return {
      tasks,
      rejected,
      unchanged: false,
      pollIntervalMs: this.#client.rateBudget.snapshot().pollIntervalMs
    };
  }
}
