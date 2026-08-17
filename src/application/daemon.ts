import type { MailboxConfig, PollConfig } from "../config/model.js";
import { parseDispatchEnvelope, sha256Utf8 } from "../domain/dispatch.js";
import type { RateBudgetGovernor } from "../domain/rate-budget.js";
import type { SourceComment } from "../domain/model.js";
import type { Clock } from "../ports/clock.js";
import type { GitHubMailbox } from "../ports/github-mailbox.js";
import type { Logger } from "../ports/logger.js";
import type { StateStore } from "../ports/state-store.js";
import { JobOrchestrator } from "./job-orchestrator.js";
import { TrustPolicy, TrustPolicyError } from "./trust-policy.js";

export interface MailboxBinding {
  readonly config: MailboxConfig;
  readonly mailbox: GitHubMailbox;
}

function retryAtMs(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = (error as { readonly retryAtMs?: unknown }).retryAtMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024);
}

export class PatchPollerDaemon {
  readonly #bindings: readonly MailboxBinding[];
  readonly #state: StateStore;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #governor: RateBudgetGovernor;
  readonly #poll: PollConfig;
  readonly #trust: TrustPolicy;
  readonly #orchestrator: JobOrchestrator;
  readonly #random: () => number;

  constructor(dependencies: {
    readonly bindings: readonly MailboxBinding[];
    readonly state: StateStore;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly governor: RateBudgetGovernor;
    readonly poll: PollConfig;
    readonly trust: TrustPolicy;
    readonly orchestrator: JobOrchestrator;
    readonly random?: () => number;
  }) {
    this.#bindings = dependencies.bindings;
    this.#state = dependencies.state;
    this.#clock = dependencies.clock;
    this.#logger = dependencies.logger;
    this.#governor = dependencies.governor;
    this.#poll = dependencies.poll;
    this.#trust = dependencies.trust;
    this.#orchestrator = dependencies.orchestrator;
    this.#random = dependencies.random ?? Math.random;
  }

  async runOnce(signal?: AbortSignal): Promise<void> {
    for (const binding of this.#bindings) {
      if (signal?.aborted === true) return;
      await this.#pollBinding(binding, signal);
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    const due = new Map(this.#bindings.map((binding) => [binding.config.id, 0]));
    while (signal?.aborted !== true) {
      const next = this.#bindings.reduce<MailboxBinding | undefined>((selected, candidate) => {
        if (selected === undefined) return candidate;
        return (due.get(candidate.config.id) ?? 0) < (due.get(selected.config.id) ?? 0)
          ? candidate
          : selected;
      }, undefined);
      if (next === undefined) throw new Error("no mailboxes are configured");
      const wait = Math.max(0, (due.get(next.config.id) ?? 0) - this.#clock.now().getTime());
      try {
        await this.#clock.sleep(wait, signal);
      } catch {
        if (signal?.aborted === true) return;
        throw new Error("mailbox scheduler sleep failed");
      }

      let explicitRetryAt: number | undefined;
      try {
        await this.#pollBinding(next, signal);
      } catch (error) {
        explicitRetryAt = retryAtMs(error);
        this.#logger.warn("mailbox poll failed", {
          mailboxId: next.config.id,
          error: boundedError(error),
          ...(explicitRetryAt === undefined ? {} : { retryAt: new Date(explicitRetryAt).toISOString() }),
        });
      }
      const cache = this.#state.getMailboxCache(next.config.id);
      const jitter = (this.#random() * 2 - 1) * this.#poll.jitterRatio;
      const delay = this.#governor.pollDelayMs(
        cache.unchangedStreak,
        cache.xPollIntervalSeconds,
        jitter,
      );
      due.set(
        next.config.id,
        Math.max(this.#clock.now().getTime() + delay, explicitRetryAt ?? 0),
      );
    }
  }

  async #pollBinding(binding: MailboxBinding, signal?: AbortSignal): Promise<void> {
    const result = await binding.mailbox.poll(signal);
    this.#logger.debug("mailbox poll completed", {
      mailboxId: binding.config.id,
      comments: result.comments.length,
      notModified: result.notModified,
      rateMode: this.#governor.mode(this.#clock.now().getTime()),
    });
    for (const comment of result.comments) {
      if (signal?.aborted === true) return;
      await this.#handleComment(binding, comment, signal);
    }
  }

  async #handleComment(
    binding: MailboxBinding,
    comment: SourceComment,
    signal?: AbortSignal,
  ): Promise<void> {
    const bodySha256 = sha256Utf8(comment.body);
    const seen = this.#state.markSourceCommentSeen(comment, bodySha256);
    if (seen === "same") return;

    try {
      this.#trust.validateSource(comment, binding.config);
    } catch (error) {
      if (!(error instanceof TrustPolicyError)) throw error;
      this.#logger.warn("ignored untrusted mailbox comment", {
        mailboxId: binding.config.id,
        commentId: comment.id,
        code: error.code,
      });
      return;
    }

    let parsed;
    try {
      parsed = parseDispatchEnvelope(comment.body);
      if (parsed === null) return;
      this.#trust.validateForClaim(parsed, this.#clock.now());
    } catch (error) {
      this.#logger.warn("trusted comment did not contain an acceptable dispatch", {
        mailboxId: binding.config.id,
        commentId: comment.id,
        error: boundedError(error),
      });
      return;
    }

    const claim = this.#state.claimDispatch(comment, parsed);
    switch (claim.status) {
      case "duplicate":
        return;
      case "comment_tampered":
        this.#logger.error("claimed dispatch comment was edited", {
          mailboxId: binding.config.id,
          commentId: comment.id,
          dispatchId: parsed.dispatch.dispatch_id,
        });
        return;
      case "stale_context_revision":
        this.#logger.warn("dispatch context revision is stale", {
          mailboxId: binding.config.id,
          commentId: comment.id,
          dispatchId: parsed.dispatch.dispatch_id,
          contextId: parsed.dispatch.context.id,
          revision: parsed.dispatch.context.revision,
        });
        return;
      case "claimed":
        await this.#orchestrator.execute(comment, parsed, claim.attempt, binding.mailbox, signal);
    }
  }
}
