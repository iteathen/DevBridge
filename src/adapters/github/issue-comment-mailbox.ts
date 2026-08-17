import type { MailboxConfig } from "../../config/model.js";
import type { SourceComment } from "../../domain/model.js";
import type { RequestPriority } from "../../domain/rate-budget.js";
import type { Clock } from "../../ports/clock.js";
import type { GitHubMailbox, PollResult } from "../../ports/github-mailbox.js";
import type { StateStore } from "../../ports/state-store.js";
import { GitHubRestClient } from "./github-rest-client.js";

interface IssueCommentWire {
  readonly id?: unknown;
  readonly node_id?: unknown;
  readonly body?: unknown;
  readonly user?: { readonly login?: unknown } | null;
  readonly author_association?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly html_url?: unknown;
  readonly performed_via_github_app?: { readonly id?: unknown } | null;
}

interface CreatedCommentWire {
  readonly id?: unknown;
}

function parseNextLink(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/u);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function parseComment(wire: IssueCommentWire, repository: string, issueNumber: number): SourceComment {
  if (!Number.isSafeInteger(wire.id) || typeof wire.node_id !== "string" || typeof wire.body !== "string" ||
      typeof wire.user?.login !== "string" || typeof wire.author_association !== "string" ||
      typeof wire.created_at !== "string" || typeof wire.updated_at !== "string" || typeof wire.html_url !== "string") {
    throw new Error("GitHub issue comment response has invalid shape");
  }
  const appId = wire.performed_via_github_app?.id;
  if (appId !== undefined && !Number.isSafeInteger(appId)) throw new Error("GitHub app identity has invalid shape");
  return {
    repository,
    issueNumber,
    id: wire.id as number,
    nodeId: wire.node_id,
    body: wire.body,
    authorLogin: wire.user.login,
    authorAssociation: wire.author_association,
    ...(appId === undefined ? {} : { appId: appId as number }),
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    htmlUrl: wire.html_url,
  };
}

export class IssueCommentMailbox implements GitHubMailbox {
  readonly id: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly #config: MailboxConfig;
  readonly #client: GitHubRestClient;
  readonly #state: StateStore;
  readonly #clock: Clock;

  constructor(config: MailboxConfig, client: GitHubRestClient, state: StateStore, clock: Clock) {
    this.#config = config;
    this.id = config.id;
    this.repository = config.repository;
    this.issueNumber = config.issueNumber;
    this.#client = client;
    this.#state = state;
    this.#clock = clock;
  }

  async poll(signal?: AbortSignal): Promise<PollResult> {
    let cache = this.#state.getMailboxCache(this.id);
    const [owner, repo] = this.repository.split("/");
    if (owner === undefined || repo === undefined) throw new Error("invalid configured repository");

    if (!cache.initialized && this.#config.bootstrap === "ignore_existing") {
      const baseline = await this.#client.request<IssueCommentWire[]>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${this.issueNumber}/comments?per_page=1`,
        "background",
        { purpose: `baseline mailbox ${this.id}`, signal },
      );
      const cursor = baseline.serverDate ?? this.#clock.now().toISOString();
      cache = {
        initialized: true,
        unchangedStreak: 0,
        cursorUpdatedAt: new Date(cursor).toISOString(),
        ...(baseline.xPollIntervalSeconds === undefined
          ? {}
          : { xPollIntervalSeconds: baseline.xPollIntervalSeconds }),
      };
      this.#state.updateMailboxCache(this.id, cache);
      return {
        comments: [],
        notModified: false,
        ...(cache.xPollIntervalSeconds === undefined
          ? {}
          : { xPollIntervalSeconds: cache.xPollIntervalSeconds }),
      };
    }

    const params = new URLSearchParams({ per_page: "100" });
    if (cache.cursorUpdatedAt !== undefined) {
      const overlap = new Date(Math.max(0, Date.parse(cache.cursorUpdatedAt) - 1000)).toISOString();
      params.set("since", overlap);
    }
    let next: string | undefined = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${this.issueNumber}/comments?${params.toString()}`;
    const comments: SourceComment[] = [];
    let first = true;
    let firstEtag: string | undefined;
    let firstLastModified: string | undefined;
    let firstPollInterval: number | undefined;
    let pages = 0;

    while (next !== undefined) {
      pages += 1;
      if (pages > 10) throw new Error("mailbox pagination exceeded safe page bound");
      const response = await this.#client.request<IssueCommentWire[]>("GET", next, "background", {
        purpose: `poll mailbox ${this.id}`,
        signal,
        ...(first
          ? { conditional: { etag: cache.etag, lastModified: cache.lastModified } }
          : {}),
      });
      if (first) {
        firstEtag = response.etag;
        firstLastModified = response.lastModified;
        firstPollInterval = response.xPollIntervalSeconds;
      }
      if (response.notModified) {
        const updated = {
          ...cache,
          initialized: true,
          unchangedStreak: cache.unchangedStreak + 1,
          ...(response.etag === undefined ? {} : { etag: response.etag }),
          ...(response.lastModified === undefined ? {} : { lastModified: response.lastModified }),
          ...(response.xPollIntervalSeconds === undefined ? {} : { xPollIntervalSeconds: response.xPollIntervalSeconds }),
        };
        this.#state.updateMailboxCache(this.id, updated);
        return {
          comments: [],
          notModified: true,
          ...(updated.etag === undefined ? {} : { etag: updated.etag }),
          ...(updated.lastModified === undefined ? {} : { lastModified: updated.lastModified }),
          ...(updated.xPollIntervalSeconds === undefined ? {} : { xPollIntervalSeconds: updated.xPollIntervalSeconds }),
        };
      }
      if (!Array.isArray(response.data)) throw new Error("GitHub issue comment response is not an array");
      comments.push(...response.data.map((wire) => parseComment(wire, this.repository, this.issueNumber)));
      next = parseNextLink(response.link);
      first = false;
    }

    comments.sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt) || left.id - right.id);
    const latest = comments.reduce<string | undefined>((current, comment) => {
      if (current === undefined || Date.parse(comment.updatedAt) > Date.parse(current)) return comment.updatedAt;
      return current;
    }, cache.cursorUpdatedAt);
    const cursorChanged = latest !== cache.cursorUpdatedAt;
    const updatedCache = {
      initialized: true,
      unchangedStreak: comments.length === 0 ? cache.unchangedStreak + 1 : 0,
      ...(latest === undefined ? {} : { cursorUpdatedAt: latest }),
      ...(!cursorChanged && firstEtag !== undefined ? { etag: firstEtag } : {}),
      ...(!cursorChanged && firstLastModified !== undefined ? { lastModified: firstLastModified } : {}),
      ...(firstPollInterval === undefined ? {} : { xPollIntervalSeconds: firstPollInterval }),
    };
    this.#state.updateMailboxCache(this.id, updatedCache);
    return {
      comments,
      notModified: false,
      ...(updatedCache.etag === undefined ? {} : { etag: updatedCache.etag }),
      ...(updatedCache.lastModified === undefined ? {} : { lastModified: updatedCache.lastModified }),
      ...(updatedCache.xPollIntervalSeconds === undefined ? {} : { xPollIntervalSeconds: updatedCache.xPollIntervalSeconds }),
    };
  }

  async createLifecycleComment(body: string, priority: RequestPriority): Promise<number> {
    const [owner, repo] = this.repository.split("/");
    if (owner === undefined || repo === undefined) throw new Error("invalid configured repository");
    const response = await this.#client.request<CreatedCommentWire>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${this.issueNumber}/comments`,
      priority,
      { purpose: `create lifecycle report for mailbox ${this.id}`, body: { body } },
    );
    if (!Number.isSafeInteger(response.data?.id)) throw new Error("GitHub create comment response is missing comment ID");
    return response.data.id as number;
  }

  async updateLifecycleComment(commentId: number, body: string, priority: RequestPriority): Promise<void> {
    const [owner, repo] = this.repository.split("/");
    if (owner === undefined || repo === undefined) throw new Error("invalid configured repository");
    await this.#client.request<unknown>(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
      priority,
      { purpose: `update lifecycle report for mailbox ${this.id}`, body: { body } },
    );
  }
}
