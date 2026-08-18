import { authoritySource, isExactAuthorityFence, isUneditedAuthorityComment, sourceBoundRevision } from './authority-source.js';
import { parseTaskEnvelope } from './task-envelope.js';

function commentIssueNumber(comment) {
  const match = String(comment?.issue_url ?? '').match(/\/issues\/(\d+)$/u);
  return match ? Number(match[1]) : null;
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

    if (response.notModified) {
      return { tasks: [], rejected: [], unchanged: true, pollIntervalMs: this.#client.rateBudget.snapshot().pollIntervalMs };
    }
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issues response must be an array');

    const commentsResponse = await this.#client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments?per_page=100&sort=created&direction=desc`,
      { conditional: false }
    );
    if (!Array.isArray(commentsResponse.data)) throw new TypeError('GitHub issue comments response must be an array');

    const commentsByIssue = new Map();
    for (const comment of commentsResponse.data) {
      const issueNumber = commentIssueNumber(comment);
      if (!issueNumber) continue;
      const list = commentsByIssue.get(issueNumber) ?? [];
      list.push(comment);
      commentsByIssue.set(issueNumber, list);
    }

    const tasks = [];
    const rejected = [];

    for (const issue of response.data) {
      if (issue?.pull_request) continue;
      const candidates = (commentsByIssue.get(issue.number) ?? [])
        .filter((comment) => this.#trustedActorIds.has(String(comment?.user?.id ?? '')) && isExactAuthorityFence(comment?.body, 'task'))
        .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
      const comment = candidates[0] ?? null;
      if (!comment) {
        rejected.push({ issueNumber: issue?.number ?? null, reason: 'missing-trusted-authority-comment' });
        continue;
      }
      if (!isUneditedAuthorityComment(comment)) {
        rejected.push({ issueNumber: issue.number, reason: 'edited-authority-comment', commentId: String(comment.id) });
        continue;
      }

      try {
        const parsed = parseTaskEnvelope(comment.body ?? '');
        const source = authoritySource(comment, { issueId: issue.id, issueNumber: issue.number });
        tasks.push({
          queueRepository: this.#queueRepository,
          issueNumber: issue.number,
          issueId: String(issue.id),
          actorId: source.actorId,
          actorLogin: source.actorLogin,
          title: issue.title ?? '',
          updatedAt: source.createdAt,
          envelope: parsed.envelope,
          envelopeRevision: parsed.revision,
          revision: sourceBoundRevision(parsed.revision, source),
          authority: source,
        });
      } catch (error) {
        rejected.push({ issueNumber: issue?.number ?? null, reason: 'invalid-envelope', detail: error.message, commentId: String(comment.id) });
      }
    }

    return {
      tasks,
      rejected,
      unchanged: false,
      pollIntervalMs: this.#client.rateBudget.snapshot().pollIntervalMs
    };
  }
}
