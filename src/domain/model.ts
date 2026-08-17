export const CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "process.execute",
  "git.worktree.create",
  "git.commit",
  "git.push",
  "github.report",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CONTEXT_FRAME_KINDS = [
  "objective",
  "checkpoint",
  "constraint",
  "decision",
  "evidence",
  "warning",
  "result",
  "handoff",
] as const;

export type ContextFrameKind = (typeof CONTEXT_FRAME_KINDS)[number];

export const CONTEXT_TRUST_CLASSES = [
  "trusted_instruction",
  "repository_authority",
  "observed_evidence",
  "untrusted_content",
] as const;

export type ContextTrustClass = (typeof CONTEXT_TRUST_CLASSES)[number];

export interface ContextSource {
  readonly kind: "controller" | "github" | "repository" | "local_observation" | "prior_handoff";
  readonly reference: string;
}

export interface ContextFrame {
  readonly id: string;
  readonly kind: ContextFrameKind;
  readonly trust: ContextTrustClass;
  readonly text: string;
  readonly source: ContextSource;
  readonly sha256: string;
}

export interface ContextBundle {
  readonly id: string;
  readonly revision: number;
  readonly objective: string;
  readonly checkpoint: string;
  readonly constraints: readonly string[];
  readonly frames: readonly ContextFrame[];
}

export interface DispatchTarget {
  readonly workspace_id: string;
  readonly checkout: string;
  readonly repository: string;
  readonly branch: string;
  readonly expected_head: string;
  readonly allowed_paths: readonly string[];
}

export type StdinSpec =
  | { readonly mode: "none" }
  | { readonly mode: "context_bundle" }
  | { readonly mode: "literal"; readonly text: string };

export interface ToolStep {
  readonly id: string;
  readonly tool_id: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: StdinSpec;
  readonly timeout_ms?: number;
}

export interface DispatchReportingPolicy {
  readonly minimum_update_interval_seconds: number;
  readonly maximum_silence_seconds: number;
  readonly include_context_handoff: boolean;
}

export interface Dispatch {
  readonly version: 1;
  readonly dispatch_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly context: ContextBundle;
  readonly target: DispatchTarget;
  readonly operation: {
    readonly kind: "tool_sequence";
    readonly steps: readonly ToolStep[];
  };
  readonly requested_capabilities: readonly Capability[];
  readonly reporting: DispatchReportingPolicy;
}

export interface ParsedDispatch {
  readonly dispatch: Dispatch;
  readonly payloadText: string;
  readonly payloadSha256: string;
}

export type LifecycleState =
  | "discovered"
  | "validating"
  | "accepted"
  | "preparing"
  | "running"
  | "verifying"
  | "committing"
  | "pushing"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "rejected";

export type RateMode = "normal" | "conserve" | "terminal_only" | "blocked";

export interface FailureReport {
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
}

export interface Handoff {
  readonly summary: string;
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  readonly constraints: readonly string[];
  readonly evidence: readonly string[];
  readonly controller_decision_needed: string;
}

export interface ContinuationFrame {
  readonly id: string;
  readonly kind: ContextFrameKind;
  readonly trust: ContextTrustClass;
  readonly text: string;
  readonly source: ContextSource;
  readonly sha256: string;
}

export interface ContinuationContext {
  readonly objective: string;
  readonly checkpoint: string;
  readonly constraints: readonly string[];
  readonly omitted_constraint_sha256: readonly string[];
  readonly frames: readonly ContinuationFrame[];
  readonly omitted_frame_sha256: readonly string[];
}

export interface SourceCommentReference {
  readonly repository: string;
  readonly issue_number: number;
  readonly comment_id: number;
  readonly html_url: string;
}

export interface LifecycleReport {
  readonly version: 1;
  readonly dispatch_id: string;
  readonly payload_sha256: string;
  readonly context_id: string;
  readonly context_revision: number;
  readonly source_comment: SourceCommentReference;
  readonly continuation: ContinuationContext;
  readonly attempt: number;
  readonly progress_sequence: number;
  readonly state: LifecycleState;
  readonly phase: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly last_meaningful_activity_at: string;
  readonly completed_at?: string;
  readonly progress: {
    readonly current_step: number;
    readonly total_steps: number;
    readonly last_completed_checkpoint: string;
  };
  readonly bounded_summary: string;
  readonly output_tail?: string;
  readonly rate_mode: RateMode;
  readonly evidence: readonly string[];
  readonly failure?: FailureReport;
  readonly final_head?: string;
  readonly changed_paths: readonly string[];
  readonly handoff?: Handoff;
}

export interface SourceComment {
  readonly repository: string;
  readonly issueNumber: number;
  readonly id: number;
  readonly nodeId: string;
  readonly body: string;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly appId?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
}
