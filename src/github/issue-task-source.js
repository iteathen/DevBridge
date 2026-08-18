import { GitHubContentProvenance, contentSha256 } from './content-provenance.js';
import { parseTaskEnvelope } from './task-envelope.js';

function boundedDetail(error) {
  const text = String(error?.message ?? error ?? 'GitHub content provenance unavailable').replace(/[\r\n\t]+/gu, ' ').trim();
  return text.length <= 400 ? text : `${text.slice(0, 397)}...`;
}

function unverifiedProvenance(issue, reason) {
  const body = typeof issue?.body === 'string' ? issue.body : '';
  return {
    verified: false,
    reason,
    nodeId: issue?.node_id ?? null,
    expectedType: 'Issue',
    contentSha256: contentSha256(body),
    creatorActorId: String(issue?.user?.id ?? ''),
    creatorLogin: issue?.user?.login ?? null,
    currentEditorActorId: null,
    editorActorIds: [],
    editCount: null,
    redactedEditCount: null,
    historyComplete: false,
    lastEditedAt: null,
  };
}

export class IssueTaskSource {
  #client;
  #queueRepository;
  #taskLabel;
  #trustedActorIds;
  #maxTasks;
  #contentProvenance;

  constructor({ client, queueRepository, taskLabel, trustedActorIds, maxTasks = 30, contentProvenance = null }) {
    this.#client = client;
    this.#queueRepository = queueRepository;
    this.#taskLabel = taskLabel;
    this.#trustedActorIds = new Set(trustedActorIds.map(String));
    this.#maxTasks = maxTasks;
    this.#contentProvenance = contentProvenance ?? new GitHubContentProvenance({ client, trustedActorIds });
  }

  async #invalidate(requestPath) {
    if (typeof this.#client.invalidateConditional === 'function') {
      await this.#client.invalidateConditional(requestPath).catch(() => {});
    }
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
    const requestPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${query}`;
    const response = await this.#client.request('GET', requestPath, { conditional: true });

    if (response.notModified) {
      return { tasks: [], rejected: [], unchanged: true, pollIntervalMs: this.#client.rateBudget.snapshot().pollIntervalMs };
    }

    if (!Array.isArray(response.data)) throw new TypeError('GitHub issues response must be an array');
    const tasks = [];
    const rejected = [];
    const pending = [];

    for (const issue of response.data) {
      if (issue?.pull_request) continue;
      const actorId = String(issue?.user?.id ?? '');
      if (!this.#trustedActorIds.has(actorId)) {
        rejected.push({
          issueNumber: issue?.number ?? null,
          reason: 'untrusted-creator',
          actorId,
          provenance: unverifiedProvenance(issue, 'untrusted-creator'),
        });
        continue;
      }

      let parsed;
      try {
        parsed = parseTaskEnvelope(issue.body ?? '');
      } catch (error) {
        rejected.push({ issueNumber: issue?.number ?? null, reason: 'invalid-envelope', detail: error.message });
        continue;
      }

      if (typeof issue?.node_id !== 'string' || issue.node_id.length === 0) {
        rejected.push({
          issueNumber: issue?.number ?? null,
          reason: 'provenance-node-id-missing',
          actorId,
          provenance: unverifiedProvenance(issue, 'provenance-node-id-missing'),
        });
        continue;
      }

      pending.push({
        issue,
        actorId,
        parsed,
        candidate: {
          nodeId: issue.node_id,
          expectedType: 'Issue',
          body: issue.body ?? '',
          authorId: actorId,
          authorLogin: issue.user?.login ?? null,
        },
      });
    }

    let provenanceResults = [];
    if (pending.length > 0) {
      try {
        provenanceResults = await this.#contentProvenance.verifyMany(pending.map((entry) => entry.candidate));
      } catch (error) {
        // The REST conditional validator may already have been persisted. Clear
        // it so a transient GraphQL/provenance failure cannot hide this content
        // behind a later 304 and make machine authority silently disappear.
        await this.#invalidate(requestPath);
        const detail = boundedDetail(error);
        for (const entry of pending) {
          rejected.push({
            issueNumber: entry.issue.number,
            reason: 'provenance-unavailable',
            detail,
            actorId: entry.actorId,
            provenance: unverifiedProvenance(entry.issue, 'provenance-unavailable'),
          });
        }
        provenanceResults = [];
      }
    }

    for (let index = 0; index < provenanceResults.length; index += 1) {
      const entry = pending[index];
      const provenance = provenanceResults[index];
      if (!provenance.verified) {
        if (provenance.reason === 'provenance-content-race') await this.#invalidate(requestPath);
        rejected.push({
          issueNumber: entry.issue.number,
          reason: provenance.reason,
          actorId: entry.actorId,
          provenance,
        });
        continue;
      }
      if (provenance.contentSha256 !== entry.parsed.contentSha256) {
        await this.#invalidate(requestPath);
        rejected.push({
          issueNumber: entry.issue.number,
          reason: 'provenance-digest-mismatch',
          actorId: entry.actorId,
          provenance: { ...provenance, verified: false, reason: 'provenance-digest-mismatch' },
        });
        continue;
      }

      tasks.push({
        queueRepository: this.#queueRepository,
        issueNumber: entry.issue.number,
        issueId: String(entry.issue.id),
        actorId: entry.actorId,
        actorLogin: entry.issue.user?.login ?? null,
        title: entry.issue.title ?? '',
        updatedAt: entry.issue.updated_at ?? null,
        envelope: entry.parsed.envelope,
        revision: entry.parsed.revision,
        contentSha256: entry.parsed.contentSha256,
        provenance,
      });
    }

    return {
      tasks,
      rejected,
      unchanged: false,
      pollIntervalMs: this.#client.rateBudget.snapshot().pollIntervalMs
    };
  }
}
