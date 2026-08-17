import type { Capability, StdinSpec } from "../domain/model.js";

export interface PollConfig {
  readonly activeIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly maximumIdleIntervalMs: number;
  readonly jitterRatio: number;
  readonly conservationRemaining: number;
  readonly criticalReserveRemaining: number;
  readonly conservationRatio: number;
}

export interface MailboxConfig {
  readonly id: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly trustedAuthors: readonly string[];
  readonly trustedAppIds: readonly number[];
  readonly allowedAuthorAssociations: readonly ("OWNER" | "MEMBER" | "COLLABORATOR")[];
  readonly bootstrap: "ignore_existing" | "scan_existing";
}

export interface GitHubConfig {
  readonly apiBaseUrl: string;
  readonly apiVersion: string;
  readonly tokenEnv: string;
  readonly userAgent: string;
  readonly poll: PollConfig;
  readonly mailboxes: readonly MailboxConfig[];
}

export interface CheckoutConfig {
  readonly repository: string;
  readonly relativePath: string;
}

export interface WorkspaceConfig {
  readonly id: string;
  readonly root: string;
  readonly worktreeRoot: string;
  readonly gitExecutable: string;
  readonly checkouts: readonly CheckoutConfig[];
}

export interface ArgumentRuleConfig {
  readonly kind: "literal" | "prefix" | "regex";
  readonly value: string;
  readonly repeat: boolean;
}

export interface ToolConfig {
  readonly id: string;
  readonly class: "deterministic" | "build_or_test" | "agent";
  readonly executable: string;
  readonly fixedArgs: readonly string[];
  readonly argumentRules: readonly ArgumentRuleConfig[];
  readonly capabilities: readonly Capability[];
  readonly stdinModes: readonly StdinSpec["mode"][];
  readonly workspaceIds: readonly string[];
  readonly maximumTimeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly inheritEnv: readonly string[];
  readonly secretEnvMap: Readonly<Record<string, string>>;
}

export interface ReportingConfig {
  readonly minimumUpdateIntervalMs: number;
  readonly maximumSilenceMs: number;
  readonly maximumCommentBytes: number;
  readonly redactAbsolutePaths: boolean;
}

export interface AppConfig {
  readonly version: 1;
  readonly state: { readonly databasePath: string };
  readonly github: GitHubConfig;
  readonly workspaces: readonly WorkspaceConfig[];
  readonly tools: readonly ToolConfig[];
  readonly reporting: ReportingConfig;
}
