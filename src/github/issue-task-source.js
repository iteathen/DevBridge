import { parseTaskEnvelope } from './task-envelope.js';

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
      return { tasks: [], unchanged: true, pollIntervalMs: this.#client.rateBudget.snapshot().pollIntervalMs };
    }

    if (!Array.isArray(response.data)) throw new TypeError('GitHub issues response must be an array');
    const tasks = [];
    const rejected = [];

    for (const issue of response.data) {
      if (issue?.pull_request) continue;
      const actorId = String(issue?.user?.id ?? '');
      if (!this.#trustedActorIds.has(actorId)) {
        rejected.push({ issueNumber: issue?.number ?? null, reason: 'untrusted-actor', actorId });
        continue;
      }

      try {
        const parsed = parseTaskEnvelope(issue.body ?? '');
        tasks.push({
          queueRepository: this.#queueRepository,
          issueNumber: issue.number,
          issueId: String(issue.id),
          actorId,
          actorLogin: issue.user?.login ?? null,
          title: issue.title ?? '',
          updatedAt: issue.updated_at ?? null,
          envelope: parsed.envelope,
          revision: parsed.revision
        });
      } catch (error) {
        rejected.push({ issueNumber: issue?.number ?? null, reason: 'invalid-envelope', detail: error.message });
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
