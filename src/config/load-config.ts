import { readFileSync } from "node:fs";
import path from "node:path";

import { CAPABILITIES, type Capability, type StdinSpec } from "../domain/model.js";
import {
  ValidationError,
  asRecord,
  assertExactKeys,
  assertUnique,
  expectArray,
  expectBoolean,
  expectInteger,
  expectNumber,
  expectOneOf,
  expectPattern,
  expectRelativePath,
  expectString,
} from "../domain/validation.js";
import type {
  AppConfig,
  ArgumentRuleConfig,
  CheckoutConfig,
  MailboxConfig,
  ToolConfig,
  WorkspaceConfig,
} from "./model.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const API_VERSION = /^\d{4}-\d{2}-\d{2}$/u;

function parseStringArray(value: unknown, pathName: string, maximum: number, minimum = 0): string[] {
  const result = expectArray(value, pathName, maximum, minimum).map((item, index) =>
    expectString(item, `${pathName}[${index}]`, 1, 4096),
  );
  assertUnique(result, pathName);
  return result;
}

function parseMailbox(value: unknown, pathName: string): MailboxConfig {
  const record = asRecord(value, pathName);
  assertExactKeys(
    record,
    ["id", "repository", "issue_number", "trusted_authors", "allowed_author_associations", "bootstrap"],
    ["trusted_app_ids"],
    pathName,
  );
  const associations = expectArray(record.allowed_author_associations, `${pathName}.allowed_author_associations`, 3, 1).map(
    (item, index) => expectOneOf(item, ["OWNER", "MEMBER", "COLLABORATOR"] as const, `${pathName}.allowed_author_associations[${index}]`),
  );
  assertUnique(associations, `${pathName}.allowed_author_associations`);
  const appIds = record.trusted_app_ids === undefined
    ? []
    : expectArray(record.trusted_app_ids, `${pathName}.trusted_app_ids`, 64).map((item, index) =>
        expectInteger(item, `${pathName}.trusted_app_ids[${index}]`, 1, Number.MAX_SAFE_INTEGER),
      );
  return {
    id: expectPattern(record.id, `${pathName}.id`, ID, 128),
    repository: expectPattern(record.repository, `${pathName}.repository`, REPOSITORY, 200),
    issueNumber: expectInteger(record.issue_number, `${pathName}.issue_number`, 1, Number.MAX_SAFE_INTEGER),
    trustedAuthors: parseStringArray(record.trusted_authors, `${pathName}.trusted_authors`, 64, 1),
    trustedAppIds: appIds,
    allowedAuthorAssociations: associations,
    bootstrap: expectOneOf(record.bootstrap, ["ignore_existing", "scan_existing"] as const, `${pathName}.bootstrap`),
  };
}

function parseCheckout(value: unknown, pathName: string): CheckoutConfig {
  const record = asRecord(value, pathName);
  assertExactKeys(record, ["repository", "relative_path"], [], pathName);
  return {
    repository: expectPattern(record.repository, `${pathName}.repository`, REPOSITORY, 200),
    relativePath: expectRelativePath(record.relative_path, `${pathName}.relative_path`),
  };
}

function parseWorkspace(value: unknown, pathName: string): WorkspaceConfig {
  const record = asRecord(value, pathName);
  assertExactKeys(record, ["id", "root", "worktree_root", "git_executable", "checkouts"], [], pathName);
  const root = expectString(record.root, `${pathName}.root`, 1, 4096);
  const worktreeRoot = expectString(record.worktree_root, `${pathName}.worktree_root`, 1, 4096);
  if (!path.isAbsolute(root)) throw new ValidationError(`${pathName}.root`, "must be absolute local path");
  if (!path.isAbsolute(worktreeRoot)) throw new ValidationError(`${pathName}.worktree_root`, "must be absolute local path");
  const checkouts = expectArray(record.checkouts, `${pathName}.checkouts`, 256, 1).map((item, index) =>
    parseCheckout(item, `${pathName}.checkouts[${index}]`),
  );
  assertUnique(checkouts.map((checkout) => checkout.repository.toLowerCase()), `${pathName}.checkouts.repository`);
  return {
    id: expectPattern(record.id, `${pathName}.id`, ID, 128),
    root,
    worktreeRoot,
    gitExecutable: expectString(record.git_executable, `${pathName}.git_executable`, 1, 4096),
    checkouts,
  };
}

function parseArgumentRule(value: unknown, pathName: string): ArgumentRuleConfig {
  const record = asRecord(value, pathName);
  assertExactKeys(record, ["kind", "value"], ["repeat"], pathName);
  const kind = expectOneOf(record.kind, ["literal", "prefix", "regex"] as const, `${pathName}.kind`);
  const ruleValue = expectString(record.value, `${pathName}.value`, 0, 4096);
  if (kind === "regex") {
    try {
      void new RegExp(ruleValue, "u");
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid regular expression";
      throw new ValidationError(`${pathName}.value`, message);
    }
  }
  return {
    kind,
    value: ruleValue,
    repeat: record.repeat === undefined ? false : expectBoolean(record.repeat, `${pathName}.repeat`),
  };
}

function parseSecretMap(value: unknown, pathName: string): Readonly<Record<string, string>> {
  const record = asRecord(value, pathName);
  const result: Record<string, string> = {};
  for (const [targetName, sourceValue] of Object.entries(record)) {
    if (!ENV_NAME.test(targetName)) throw new ValidationError(`${pathName}.${targetName}`, "invalid target environment name");
    result[targetName] = expectPattern(sourceValue, `${pathName}.${targetName}`, ENV_NAME, 256);
  }
  return result;
}

function parseTool(value: unknown, pathName: string): ToolConfig {
  const record = asRecord(value, pathName);
  assertExactKeys(
    record,
    ["id", "class", "executable", "fixed_args", "argument_rules", "capabilities", "stdin_modes", "workspace_ids", "maximum_timeout_ms", "maximum_output_bytes", "inherit_env", "secret_env_map"],
    [],
    pathName,
  );
  const capabilities = expectArray(record.capabilities, `${pathName}.capabilities`, 16, 1).map((item, index) =>
    expectOneOf(item, CAPABILITIES, `${pathName}.capabilities[${index}]`) as Capability,
  );
  assertUnique(capabilities, `${pathName}.capabilities`);
  const stdinModes = expectArray(record.stdin_modes, `${pathName}.stdin_modes`, 3, 1).map((item, index) =>
    expectOneOf(item, ["none", "literal", "context_bundle"] as const, `${pathName}.stdin_modes[${index}]`) as StdinSpec["mode"],
  );
  assertUnique(stdinModes, `${pathName}.stdin_modes`);
  const inheritEnv = parseStringArray(record.inherit_env, `${pathName}.inherit_env`, 128).map((name) => {
    if (!ENV_NAME.test(name)) throw new ValidationError(`${pathName}.inherit_env`, `invalid environment name: ${name}`);
    return name;
  });
  return {
    id: expectPattern(record.id, `${pathName}.id`, ID, 128),
    class: expectOneOf(record.class, ["deterministic", "build_or_test", "agent"] as const, `${pathName}.class`),
    executable: expectString(record.executable, `${pathName}.executable`, 1, 4096),
    fixedArgs: parseStringArray(record.fixed_args, `${pathName}.fixed_args`, 128),
    argumentRules: expectArray(record.argument_rules, `${pathName}.argument_rules`, 128).map((item, index) =>
      parseArgumentRule(item, `${pathName}.argument_rules[${index}]`),
    ),
    capabilities,
    stdinModes,
    workspaceIds: parseStringArray(record.workspace_ids, `${pathName}.workspace_ids`, 100, 1),
    maximumTimeoutMs: expectInteger(record.maximum_timeout_ms, `${pathName}.maximum_timeout_ms`, 1000, 86_400_000),
    maximumOutputBytes: expectInteger(record.maximum_output_bytes, `${pathName}.maximum_output_bytes`, 1024, 1_073_741_824),
    inheritEnv,
    secretEnvMap: parseSecretMap(record.secret_env_map, `${pathName}.secret_env_map`),
  };
}

export function parseConfig(value: unknown): AppConfig {
  const record = asRecord(value, "$");
  assertExactKeys(record, ["version", "state", "github", "workspaces", "tools", "reporting"], [], "$");
  if (record.version !== 1) throw new ValidationError("$.version", "must equal 1");

  const state = asRecord(record.state, "$.state");
  assertExactKeys(state, ["database_path"], [], "$.state");

  const github = asRecord(record.github, "$.github");
  assertExactKeys(github, ["api_base_url", "api_version", "token_env", "user_agent", "poll", "mailboxes"], [], "$.github");
  const apiBaseUrl = expectString(github.api_base_url, "$.github.api_base_url", 1, 4096);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiBaseUrl);
  } catch {
    throw new ValidationError("$.github.api_base_url", "must be a valid URL");
  }
  if (parsedUrl.protocol !== "https:") throw new ValidationError("$.github.api_base_url", "must use HTTPS");

  const poll = asRecord(github.poll, "$.github.poll");
  assertExactKeys(
    poll,
    ["active_interval_ms", "idle_interval_ms", "maximum_idle_interval_ms", "jitter_ratio", "conservation_remaining", "critical_reserve_remaining", "conservation_ratio"],
    [],
    "$.github.poll",
  );
  const conservationRemaining = expectInteger(poll.conservation_remaining, "$.github.poll.conservation_remaining", 1, Number.MAX_SAFE_INTEGER);
  const criticalReserveRemaining = expectInteger(poll.critical_reserve_remaining, "$.github.poll.critical_reserve_remaining", 1, Number.MAX_SAFE_INTEGER);
  if (criticalReserveRemaining >= conservationRemaining) {
    throw new ValidationError("$.github.poll.critical_reserve_remaining", "must be lower than conservation_remaining");
  }

  const workspaces = expectArray(record.workspaces, "$.workspaces", 100, 1).map((item, index) =>
    parseWorkspace(item, `$.workspaces[${index}]`),
  );
  assertUnique(workspaces.map((workspace) => workspace.id), "$.workspaces.id");
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));

  const tools = expectArray(record.tools, "$.tools", 256, 1).map((item, index) =>
    parseTool(item, `$.tools[${index}]`),
  );
  assertUnique(tools.map((tool) => tool.id), "$.tools.id");
  for (const tool of tools) {
    for (const workspaceId of tool.workspaceIds) {
      if (!workspaceIds.has(workspaceId)) throw new ValidationError(`$.tools.${tool.id}.workspace_ids`, `unknown workspace: ${workspaceId}`);
    }
    if (tool.class === "agent" && !tool.capabilities.includes("workspace.write")) {
      throw new ValidationError(`$.tools.${tool.id}.capabilities`, "agent tools must declare workspace.write");
    }
  }

  const reporting = asRecord(record.reporting, "$.reporting");
  assertExactKeys(reporting, ["minimum_update_interval_ms", "maximum_silence_ms", "maximum_comment_bytes", "redact_absolute_paths"], [], "$.reporting");
  const minimumUpdateIntervalMs = expectInteger(reporting.minimum_update_interval_ms, "$.reporting.minimum_update_interval_ms", 30_000, 3_600_000);
  const maximumSilenceMs = expectInteger(reporting.maximum_silence_ms, "$.reporting.maximum_silence_ms", 60_000, 86_400_000);
  if (maximumSilenceMs < minimumUpdateIntervalMs) throw new ValidationError("$.reporting.maximum_silence_ms", "must not be shorter than minimum update interval");

  const mailboxes = expectArray(github.mailboxes, "$.github.mailboxes", 100, 1).map((item, index) =>
    parseMailbox(item, `$.github.mailboxes[${index}]`),
  );
  assertUnique(mailboxes.map((mailbox) => mailbox.id), "$.github.mailboxes.id");

  return {
    version: 1,
    state: { databasePath: expectString(state.database_path, "$.state.database_path", 1, 4096) },
    github: {
      apiBaseUrl: parsedUrl.toString().replace(/\/$/u, ""),
      apiVersion: expectPattern(github.api_version, "$.github.api_version", API_VERSION, 10),
      tokenEnv: expectPattern(github.token_env, "$.github.token_env", ENV_NAME, 256),
      userAgent: expectString(github.user_agent, "$.github.user_agent", 1, 200),
      poll: {
        activeIntervalMs: expectInteger(poll.active_interval_ms, "$.github.poll.active_interval_ms", 30_000, 3_600_000),
        idleIntervalMs: expectInteger(poll.idle_interval_ms, "$.github.poll.idle_interval_ms", 30_000, 3_600_000),
        maximumIdleIntervalMs: expectInteger(poll.maximum_idle_interval_ms, "$.github.poll.maximum_idle_interval_ms", 60_000, 86_400_000),
        jitterRatio: expectNumber(poll.jitter_ratio, "$.github.poll.jitter_ratio", 0, 0.25),
        conservationRemaining,
        criticalReserveRemaining,
        conservationRatio: expectNumber(poll.conservation_ratio, "$.github.poll.conservation_ratio", 0.01, 0.9),
      },
      mailboxes,
    },
    workspaces,
    tools,
    reporting: {
      minimumUpdateIntervalMs,
      maximumSilenceMs,
      maximumCommentBytes: expectInteger(reporting.maximum_comment_bytes, "$.reporting.maximum_comment_bytes", 4096, 60_000),
      redactAbsolutePaths: expectBoolean(reporting.redact_absolute_paths, "$.reporting.redact_absolute_paths"),
    },
  };
}

export function loadConfig(filename: string): AppConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(filename, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown configuration error";
    throw new ValidationError("$", `configuration could not be read: ${message}`);
  }
  return parseConfig(decoded);
}
