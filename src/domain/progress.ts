import type {
  ContinuationContext,
  Handoff,
  LifecycleReport,
  LifecycleState,
  RateMode,
} from "./model.js";

export interface ProgressEvent {
  readonly sequence: number;
  readonly state: LifecycleState;
  readonly phase: string;
  readonly at: string;
  readonly summary: string;
  readonly currentStep?: number;
  readonly totalSteps?: number;
  readonly checkpoint?: string;
  readonly evidence?: string;
  readonly outputTail?: string;
}

export interface ProgressProjectionPolicy {
  readonly minimumUpdateIntervalMs: number;
  readonly maximumSilenceMs: number;
}

const TERMINAL_STATES = new Set<LifecycleState>([
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
  "rejected",
]);

export function isTerminalState(state: LifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function applyProgressEvent(report: LifecycleReport, event: ProgressEvent, rateMode: RateMode): LifecycleReport {
  if (event.sequence <= report.progress_sequence) throw new Error("progress sequence must increase");
  const evidence = event.evidence === undefined
    ? report.evidence
    : [...report.evidence, event.evidence].slice(-64);
  const terminal = isTerminalState(event.state);
  return {
    ...report,
    progress_sequence: event.sequence,
    state: event.state,
    phase: event.phase,
    updated_at: event.at,
    last_meaningful_activity_at: event.at,
    ...(terminal ? { completed_at: event.at } : {}),
    progress: {
      current_step: event.currentStep ?? report.progress.current_step,
      total_steps: event.totalSteps ?? report.progress.total_steps,
      last_completed_checkpoint: event.checkpoint ?? report.progress.last_completed_checkpoint,
    },
    bounded_summary: event.summary.slice(0, 4096),
    ...(event.outputTail === undefined ? {} : { output_tail: event.outputTail.slice(-8192) }),
    rate_mode: rateMode,
    evidence,
  };
}

export function shouldProjectProgress(
  previous: LifecycleReport | undefined,
  current: LifecycleReport,
  lastProjectedAtMs: number | undefined,
  nowMs: number,
  policy: ProgressProjectionPolicy,
): boolean {
  if (previous === undefined || lastProjectedAtMs === undefined) return true;
  if (isTerminalState(current.state)) return true;
  const material =
    previous.state !== current.state ||
    previous.phase !== current.phase ||
    previous.progress.current_step !== current.progress.current_step ||
    previous.progress.last_completed_checkpoint !== current.progress.last_completed_checkpoint ||
    previous.bounded_summary !== current.bounded_summary ||
    previous.rate_mode !== current.rate_mode;
  const elapsed = nowMs - lastProjectedAtMs;
  if (material && elapsed >= policy.minimumUpdateIntervalMs) return true;
  return elapsed >= policy.maximumSilenceMs;
}

function compactContinuation(continuation: ContinuationContext): ContinuationContext {
  return {
    ...continuation,
    constraints: continuation.constraints.slice(0, 16),
    frames: continuation.frames
      .filter((frame) => frame.trust === "trusted_instruction" || frame.trust === "repository_authority")
      .slice(0, 16)
      .map((frame) => ({ ...frame, text: frame.text.slice(0, 2048) })),
    omitted_constraint_sha256: continuation.omitted_constraint_sha256.slice(0, 32),
    omitted_frame_sha256: continuation.omitted_frame_sha256.slice(0, 64),
  };
}

function compactHandoff(handoff: Handoff | undefined): Handoff | undefined {
  if (handoff === undefined) return undefined;
  return {
    summary: handoff.summary.slice(0, 4096),
    completed: handoff.completed.slice(-32),
    remaining: handoff.remaining.slice(0, 32),
    constraints: handoff.constraints.slice(0, 16),
    evidence: handoff.evidence.slice(-32),
    controller_decision_needed: handoff.controller_decision_needed.slice(0, 2048),
  };
}

function compactReport(report: LifecycleReport): LifecycleReport {
  const handoff = compactHandoff(report.handoff);
  return {
    ...report,
    bounded_summary: report.bounded_summary.slice(0, 2048),
    ...(report.output_tail === undefined ? {} : { output_tail: report.output_tail.slice(-2048) }),
    evidence: report.evidence.slice(-16),
    changed_paths: report.changed_paths.slice(0, 128),
    continuation: compactContinuation(report.continuation),
    ...(handoff === undefined ? {} : { handoff }),
  };
}

function humanLines(report: LifecycleReport): string[] {
  const progress = report.progress.total_steps === 0
    ? "not started"
    : `${report.progress.current_step}/${report.progress.total_steps}`;
  const lines = [
    `### PATCH-POLLER — ${report.state}`,
    "",
    `- Dispatch: \`${report.dispatch_id}\``,
    `- Context: \`${report.context_id}@${report.context_revision}\``,
    `- Attempt: \`${report.attempt}\``,
    `- Phase: \`${report.phase}\``,
    `- Progress: \`${progress}\``,
    `- Rate mode: \`${report.rate_mode}\``,
    `- Last activity: \`${report.last_meaningful_activity_at}\``,
    "",
    report.bounded_summary,
  ];
  if (report.progress.last_completed_checkpoint) {
    lines.push("", `Last checkpoint: ${report.progress.last_completed_checkpoint}`);
  }
  if (report.failure !== undefined) {
    lines.push("", `Failure \`${report.failure.code}\`: ${report.failure.message}`);
  }
  if (report.handoff !== undefined) {
    lines.push("", "#### Handoff", "", report.handoff.summary);
  }
  return lines;
}

export function renderLifecycleComment(report: LifecycleReport, maximumBytes = 60_000): string {
  const render = (value: LifecycleReport): string =>
    `${humanLines(value).join("\n")}\n\n<!-- PATCH-POLLER-REPORT v1\n${JSON.stringify(value)}\n-->`;
  let rendered = render(report);
  if (Buffer.byteLength(rendered, "utf8") <= maximumBytes) return rendered;
  rendered = render(compactReport(report));
  if (Buffer.byteLength(rendered, "utf8") > maximumBytes) {
    throw new Error("lifecycle report cannot be rendered within configured byte limit");
  }
  return rendered;
}
