import type { LifecycleReport } from "../domain/model.js";
import { renderLifecycleComment, shouldProjectProgress } from "../domain/progress.js";
import type { RequestPriority } from "../domain/rate-budget.js";
import type { Clock } from "../ports/clock.js";
import type { GitHubMailbox } from "../ports/github-mailbox.js";
import type { Logger } from "../ports/logger.js";
import type { StateStore } from "../ports/state-store.js";

interface PendingProjection {
  readonly report: LifecycleReport;
  readonly priority: RequestPriority;
}

interface ProjectedState {
  readonly report: LifecycleReport;
  readonly atMs: number;
}

function strongerPriority(left: RequestPriority, right: RequestPriority): RequestPriority {
  const weight: Readonly<Record<RequestPriority, number>> = {
    background: 0,
    normal: 1,
    critical: 2,
  };
  return weight[left] >= weight[right] ? left : right;
}

export class ProgressReporter {
  readonly #mailbox: GitHubMailbox;
  readonly #state: StateStore;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #policy: {
    readonly minimumUpdateIntervalMs: number;
    readonly maximumSilenceMs: number;
    readonly maximumCommentBytes: number;
  };
  readonly #projected = new Map<string, ProjectedState>();
  readonly #pending = new Map<string, PendingProjection>();
  #tail: Promise<void> = Promise.resolve();

  constructor(
    mailbox: GitHubMailbox,
    state: StateStore,
    clock: Clock,
    logger: Logger,
    policy: {
      readonly minimumUpdateIntervalMs: number;
      readonly maximumSilenceMs: number;
      readonly maximumCommentBytes: number;
    },
  ) {
    this.#mailbox = mailbox;
    this.#state = state;
    this.#clock = clock;
    this.#logger = logger;
    this.#policy = policy;
  }

  record(report: LifecycleReport, priority: RequestPriority, force = false): void {
    this.#state.saveLifecycleReport(report);
    const projected = this.#projected.get(report.dispatch_id);
    const nowMs = this.#clock.now().getTime();
    if (!force && !shouldProjectProgress(
      projected?.report,
      report,
      projected?.atMs,
      nowMs,
      this.#policy,
    )) {
      return;
    }
    const existing = this.#pending.get(report.dispatch_id);
    this.#pending.set(report.dispatch_id, {
      report,
      priority: existing === undefined ? priority : strongerPriority(existing.priority, priority),
    });
    this.#tail = this.#tail.then(
      () => this.#project(report.dispatch_id),
      () => this.#project(report.dispatch_id),
    );
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  async #project(dispatchId: string): Promise<void> {
    const pending = this.#pending.get(dispatchId);
    if (pending === undefined) return;
    const body = renderLifecycleComment(pending.report, this.#policy.maximumCommentBytes);
    try {
      let commentId = this.#state.getReportCommentId(dispatchId);
      if (commentId === undefined) {
        commentId = await this.#mailbox.createLifecycleComment(body, pending.priority);
        this.#state.setReportCommentId(dispatchId, commentId);
      } else {
        await this.#mailbox.updateLifecycleComment(commentId, body, pending.priority);
      }
      this.#projected.set(dispatchId, {
        report: pending.report,
        atMs: this.#clock.now().getTime(),
      });
      if (this.#pending.get(dispatchId) === pending) this.#pending.delete(dispatchId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn("lifecycle projection deferred", {
        dispatchId,
        state: pending.report.state,
        priority: pending.priority,
        error: message.slice(0, 1024),
      });
    }
  }
}
