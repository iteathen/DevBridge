import type { LifecycleReport, ParsedDispatch, SourceComment } from "../domain/model.js";
import type { RateSnapshot } from "../domain/rate-budget.js";

export interface MailboxCache {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly initialized: boolean;
  readonly unchangedStreak: number;
  readonly xPollIntervalSeconds?: number;
}

export type DispatchClaimResult =
  | { readonly status: "claimed"; readonly attempt: number }
  | { readonly status: "duplicate" }
  | { readonly status: "comment_tampered" }
  | { readonly status: "stale_context_revision" };

export interface StateStore {
  initialize(): void;
  close(): void;
  getMailboxCache(mailboxId: string): MailboxCache;
  updateMailboxCache(mailboxId: string, cache: MailboxCache): void;
  markSourceCommentSeen(comment: SourceComment, bodySha256: string): "new" | "same" | "edited";
  claimDispatch(comment: SourceComment, parsed: ParsedDispatch): DispatchClaimResult;
  saveLifecycleReport(report: LifecycleReport): void;
  getLifecycleReport(dispatchId: string): LifecycleReport | undefined;
  setReportCommentId(dispatchId: string, commentId: number): void;
  getReportCommentId(dispatchId: string): number | undefined;
  recordRateSnapshot(snapshot: RateSnapshot): void;
}
