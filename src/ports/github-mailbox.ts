import type { SourceComment } from "../domain/model.js";
import type { RequestPriority } from "../domain/rate-budget.js";

export interface PollResult {
  readonly comments: readonly SourceComment[];
  readonly notModified: boolean;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly xPollIntervalSeconds?: number;
}

export interface GitHubMailbox {
  readonly id: string;
  readonly repository: string;
  readonly issueNumber: number;
  poll(signal?: AbortSignal): Promise<PollResult>;
  createLifecycleComment(body: string, priority: RequestPriority): Promise<number>;
  updateLifecycleComment(commentId: number, body: string, priority: RequestPriority): Promise<void>;
}
