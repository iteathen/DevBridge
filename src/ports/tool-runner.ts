import type { Capability, ContextBundle, StdinSpec, ToolStep } from "../domain/model.js";

export interface ToolProgress {
  readonly kind: "process_started" | "liveness" | "output_activity" | "process_exited" | "timeout" | "signal" | "warning";
  readonly at: string;
  readonly message: string;
  readonly outputTail?: string;
}

export interface ToolExecutionRequest {
  readonly step: ToolStep;
  readonly workspaceId: string;
  readonly checkoutPath: string;
  readonly context: ContextBundle;
  readonly requestedCapabilities: readonly Capability[];
  readonly signal?: AbortSignal;
  readonly onProgress: (event: ToolProgress) => void;
}

export interface ToolExecutionResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly outputTruncated: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ToolRunner {
  validateStep(step: ToolStep, workspaceId: string, requestedCapabilities: readonly Capability[]): void;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

export interface RegisteredTool {
  readonly id: string;
  readonly class: "deterministic" | "build_or_test" | "agent";
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly argumentRules: readonly {
    readonly kind: "literal" | "prefix" | "regex";
    readonly value: string;
    readonly repeat: boolean;
  }[];
  readonly capabilities: readonly Capability[];
  readonly stdinModes: readonly StdinSpec["mode"][];
  readonly workspaceIds: readonly string[];
  readonly maximumTimeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly inheritEnv: readonly string[];
  readonly secretEnvMap: Readonly<Record<string, string>>;
}
