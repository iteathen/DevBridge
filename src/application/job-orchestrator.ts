import type { ReportingConfig } from "../config/model.js";
import { buildContinuationContext } from "../domain/context.js";
import type {
  FailureReport,
  Handoff,
  LifecycleReport,
  LifecycleState,
  ParsedDispatch,
  SourceComment,
} from "../domain/model.js";
import { applyProgressEvent } from "../domain/progress.js";
import type { RateMode } from "../domain/model.js";
import type { Clock } from "../ports/clock.js";
import type { GitHubMailbox } from "../ports/github-mailbox.js";
import type { Logger } from "../ports/logger.js";
import type { StateStore } from "../ports/state-store.js";
import type { ToolExecutionResult, ToolProgress, ToolRunner } from "../ports/tool-runner.js";
import type { WorkspaceGuard } from "../ports/workspace-guard.js";
import { ProgressReporter } from "./progress-reporter.js";

const READ_ONLY_CAPABILITIES = new Set([
  "workspace.read",
  "process.execute",
  "github.report",
]);

export class ReadOnlySlicePolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReadOnlySlicePolicyError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputTail(result: ToolExecutionResult): string {
  return `${result.stdoutTail}\n${result.stderrTail}`.trim().slice(-8192);
}

export class JobOrchestrator {
  constructor(
    readonly state: StateStore,
    readonly runner: ToolRunner,
    readonly workspaceGuard: WorkspaceGuard,
    readonly clock: Clock,
    readonly logger: Logger,
    readonly reporting: ReportingConfig,
    readonly rateMode: () => RateMode,
  ) {}

  async execute(
    comment: SourceComment,
    parsed: ParsedDispatch,
    attempt: number,
    mailbox: GitHubMailbox,
    signal?: AbortSignal,
  ): Promise<LifecycleReport> {
    const dispatch = parsed.dispatch;
    const requestedMinimum = dispatch.reporting.minimum_update_interval_seconds * 1000;
    const requestedSilence = dispatch.reporting.maximum_silence_seconds * 1000;
    const minimumUpdateIntervalMs = Math.max(this.reporting.minimumUpdateIntervalMs, requestedMinimum);
    const maximumSilenceMs = Math.max(
      minimumUpdateIntervalMs,
      Math.min(this.reporting.maximumSilenceMs, requestedSilence),
    );
    const reporter = new ProgressReporter(mailbox, this.state, this.clock, this.logger, {
      minimumUpdateIntervalMs,
      maximumSilenceMs,
      maximumCommentBytes: this.reporting.maximumCommentBytes,
    });

    const startedAt = this.clock.now().toISOString();
    let report: LifecycleReport = {
      version: 1,
      dispatch_id: dispatch.dispatch_id,
      payload_sha256: parsed.payloadSha256,
      context_id: dispatch.context.id,
      context_revision: dispatch.context.revision,
      source_comment: {
        repository: comment.repository,
        issue_number: comment.issueNumber,
        comment_id: comment.id,
        html_url: comment.htmlUrl,
      },
      continuation: buildContinuationContext(dispatch.context),
      attempt,
      progress_sequence: 0,
      state: "accepted",
      phase: "accepted",
      started_at: startedAt,
      updated_at: startedAt,
      last_meaningful_activity_at: startedAt,
      progress: {
        current_step: 0,
        total_steps: dispatch.operation.steps.length,
        last_completed_checkpoint: dispatch.context.checkpoint,
      },
      bounded_summary: `Accepted ${dispatch.operation.steps.length} locally registered tool step(s) for ${dispatch.target.repository}.`,
      rate_mode: this.rateMode(),
      evidence: [
        `source comment ${comment.repository}#${comment.issueNumber}:${comment.id}`,
        `payload sha256 ${parsed.payloadSha256}`,
        `expected head ${dispatch.target.expected_head}`,
      ],
      changed_paths: [],
    };
    reporter.record(report, "normal", true);
    await reporter.flush();
    this.#log(report);

    const completed: string[] = [];
    const remaining = dispatch.operation.steps.map((step) => step.id);
    let sequence = 0;

    const emit = (
      state: LifecycleState,
      phase: string,
      summary: string,
      options: {
        readonly currentStep?: number;
        readonly checkpoint?: string;
        readonly evidence?: string;
        readonly outputTail?: string;
        readonly priority?: "background" | "normal" | "critical";
        readonly force?: boolean;
      } = {},
    ): void => {
      sequence += 1;
      report = applyProgressEvent(report, {
        sequence,
        state,
        phase,
        at: this.clock.now().toISOString(),
        summary,
        currentStep: options.currentStep,
        totalSteps: dispatch.operation.steps.length,
        checkpoint: options.checkpoint,
        evidence: options.evidence,
        outputTail: options.outputTail,
      }, this.rateMode());
      reporter.record(report, options.priority ?? "normal", options.force ?? false);
      this.#log(report);
    };

    const handoff = (summary: string): Handoff => ({
      summary,
      completed,
      remaining,
      constraints: dispatch.context.constraints,
      evidence: report.evidence,
      controller_decision_needed:
        "Review this exact handoff and choose the next action. PATCH-POLLER did not select next_step.",
    });

    const terminal = async (
      state: "completed" | "failed" | "blocked" | "cancelled" | "interrupted",
      phase: string,
      summary: string,
      failure?: FailureReport,
      finalHead?: string,
    ): Promise<LifecycleReport> => {
      report = {
        ...report,
        ...(failure === undefined ? {} : { failure }),
        ...(finalHead === undefined ? {} : { final_head: finalHead }),
        handoff: handoff(summary),
      };
      emit(state, phase, summary, { priority: "critical", force: true });
      await reporter.flush();
      return report;
    };

    try {
      const unsupported = dispatch.requested_capabilities.filter(
        (capability) => !READ_ONLY_CAPABILITIES.has(capability),
      );
      if (unsupported.length > 0) {
        throw new ReadOnlySlicePolicyError(
          "WRITE_CAPABILITY_NOT_ENABLED",
          `bootstrap release does not enable: ${unsupported.join(", ")}`,
        );
      }
      if (!dispatch.requested_capabilities.includes("workspace.read") ||
          !dispatch.requested_capabilities.includes("process.execute")) {
        throw new ReadOnlySlicePolicyError(
          "READ_EXECUTE_CAPABILITIES_REQUIRED",
          "tool execution requires workspace.read and process.execute",
        );
      }
      if (dispatch.target.allowed_paths.length !== 0) {
        throw new ReadOnlySlicePolicyError(
          "READ_ONLY_ALLOWED_PATHS_MUST_BE_EMPTY",
          "bootstrap read-only execution requires an empty allowed_paths list",
        );
      }
      for (const step of dispatch.operation.steps) {
        this.runner.validateStep(step, dispatch.target.workspace_id, dispatch.requested_capabilities);
      }

      emit("preparing", "workspace-guard", "Verifying the configured checkout, repository, branch, exact head, links, and clean state.");
      let verified = this.workspaceGuard.verify(dispatch.target);
      emit("preparing", "workspace-ready", "Read-only checkout guard passed.", {
        checkpoint: `workspace verified at ${verified.head}`,
        evidence: `workspace guard passed for ${verified.repository}@${verified.head}`,
      });

      for (let index = 0; index < dispatch.operation.steps.length; index += 1) {
        if (signal?.aborted === true) {
          return await terminal("cancelled", "cancelled", "Execution was cancelled before the next step.", {
            category: "cancellation",
            code: "DISPATCH_CANCELLED",
            message: "dispatch cancellation signal was observed",
            retriable: false,
          }, verified.head);
        }
        const step = dispatch.operation.steps[index];
        if (step === undefined) throw new Error("tool step disappeared during execution");
        emit("running", `step:${step.id}`, `Starting step ${index + 1}/${dispatch.operation.steps.length}: ${step.id}.`, {
          currentStep: index + 1,
        });

        const result = await this.runner.execute({
          step,
          workspaceId: verified.workspaceId,
          checkoutPath: verified.checkoutPath,
          context: dispatch.context,
          requestedCapabilities: dispatch.requested_capabilities,
          signal,
          onProgress: (event: ToolProgress) => {
            emit("running", `step:${step.id}:${event.kind}`, event.message, {
              currentStep: index + 1,
              outputTail: event.outputTail,
            });
          },
        });
        await reporter.flush();

        if (result.timedOut) {
          return await terminal("failed", `step:${step.id}:timeout`, `Step ${step.id} exceeded its locally configured timeout.`, {
            category: "tool_execution",
            code: "TOOL_TIMEOUT",
            message: `local tool step ${step.id} timed out`,
            retriable: false,
          }, verified.head);
        }
        if (result.exitCode !== 0) {
          return await terminal("failed", `step:${step.id}:failed`, `Step ${step.id} failed with exit ${result.exitCode ?? result.signal ?? "unknown"}.`, {
            category: "tool_execution",
            code: "TOOL_EXIT_NONZERO",
            message: `local tool step ${step.id} failed`,
            retriable: false,
          }, verified.head);
        }

        verified = this.workspaceGuard.verify(dispatch.target);
        completed.push(step.id);
        remaining.shift();
        emit("running", `step:${step.id}:completed`, `Step ${step.id} completed and the read-only checkout audit remained clean.`, {
          currentStep: index + 1,
          checkpoint: `completed ${step.id}`,
          evidence: `${step.id}: exit 0${result.outputTruncated ? "; bounded output was truncated locally" : ""}`,
          outputTail: outputTail(result),
        });
      }

      emit("verifying", "final-read-only-audit", "Running the final repository identity and no-change audit.");
      const final = this.workspaceGuard.verify(dispatch.target);
      return await terminal(
        "completed",
        "completed",
        `Completed ${completed.length}/${dispatch.operation.steps.length} step(s); exact head and clean read-only state were preserved.`,
        undefined,
        final.head,
      );
    } catch (error) {
      if (signal?.aborted === true) {
        return await terminal("cancelled", "cancelled", "Execution was cancelled.", {
          category: "cancellation",
          code: "DISPATCH_CANCELLED",
          message: "dispatch cancellation signal was observed",
          retriable: false,
        });
      }
      if (error instanceof ReadOnlySlicePolicyError) {
        return await terminal("blocked", "local-policy", error.message, {
          category: "local_policy",
          code: error.code,
          message: error.message.slice(0, 4096),
          retriable: false,
        });
      }
      const message = messageOf(error).slice(0, 4096);
      return await terminal("blocked", "safety-guard", `Local safety verification stopped execution: ${message}`, {
        category: "local_safety",
        code: "LOCAL_GUARD_OR_EXECUTION_FAILURE",
        message,
        retriable: false,
      });
    }
  }

  #log(report: LifecycleReport): void {
    this.logger.info("dispatch progress", {
      dispatchId: report.dispatch_id,
      sequence: report.progress_sequence,
      state: report.state,
      phase: report.phase,
      step: `${report.progress.current_step}/${report.progress.total_steps}`,
      summary: report.bounded_summary,
      rateMode: report.rate_mode,
    });
  }
}
