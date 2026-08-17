import { createHash } from "node:crypto";

import {
  CAPABILITIES,
  CONTEXT_FRAME_KINDS,
  CONTEXT_TRUST_CLASSES,
  type Capability,
  type ContextBundle,
  type ContextFrame,
  type Dispatch,
  type DispatchTarget,
  type ParsedDispatch,
  type StdinSpec,
  type ToolStep,
} from "./model.js";
import {
  ValidationError,
  asRecord,
  assertExactKeys,
  assertUnique,
  expectArray,
  expectBoolean,
  expectDateTime,
  expectInteger,
  expectOneOf,
  expectPattern,
  expectRelativePath,
  expectString,
} from "./validation.js";

export const DISPATCH_MARKER = "PATCH-POLLER-DISPATCH v1";
export const MAXIMUM_ENVELOPE_BYTES = 262_144;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GIT_SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function extractDispatchPayload(body: string): string | null {
  const expression = new RegExp(
    `<!--\\s*${DISPATCH_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\r?\\n([\\s\\S]*?)-->`,
    "gu",
  );
  const matches = [...body.matchAll(expression)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new ValidationError("$", "dispatch comment contains multiple markers");
  const payload = matches[0]?.[1]?.trim();
  if (!payload) throw new ValidationError("$", "dispatch envelope is empty");
  if (Buffer.byteLength(payload, "utf8") > MAXIMUM_ENVELOPE_BYTES) {
    throw new ValidationError("$", "dispatch envelope exceeds byte limit");
  }
  return payload;
}

function parseSource(value: unknown, path: string): ContextFrame["source"] {
  const record = asRecord(value, path);
  assertExactKeys(record, ["kind", "reference"], [], path);
  return {
    kind: expectOneOf(
      record.kind,
      ["controller", "github", "repository", "local_observation", "prior_handoff"] as const,
      `${path}.kind`,
    ),
    reference: expectString(record.reference, `${path}.reference`, 1, 4096),
  };
}

function parseFrame(value: unknown, path: string): ContextFrame {
  const record = asRecord(value, path);
  assertExactKeys(record, ["id", "kind", "trust", "text", "source", "sha256"], [], path);
  const text = expectString(record.text, `${path}.text`, 1, 16_384);
  const digest = expectPattern(record.sha256, `${path}.sha256`, SHA256, 64);
  if (sha256Utf8(text) !== digest) throw new ValidationError(`${path}.sha256`, "does not match frame text");
  return {
    id: expectPattern(record.id, `${path}.id`, SAFE_ID, 128),
    kind: expectOneOf(record.kind, CONTEXT_FRAME_KINDS, `${path}.kind`),
    trust: expectOneOf(record.trust, CONTEXT_TRUST_CLASSES, `${path}.trust`),
    text,
    source: parseSource(record.source, `${path}.source`),
    sha256: digest,
  };
}

function parseContext(value: unknown, path: string): ContextBundle {
  const record = asRecord(value, path);
  assertExactKeys(record, ["id", "revision", "objective", "checkpoint", "constraints", "frames"], [], path);
  const constraints = expectArray(record.constraints, `${path}.constraints`, 64).map((item, index) =>
    expectString(item, `${path}.constraints[${index}]`, 1, 2048),
  );
  const frames = expectArray(record.frames, `${path}.frames`, 128).map((item, index) =>
    parseFrame(item, `${path}.frames[${index}]`),
  );
  assertUnique(frames.map((frame) => frame.id), `${path}.frames`);
  const totalBytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.text, "utf8"), 0);
  if (totalBytes > 196_608) throw new ValidationError(`${path}.frames`, "combined frame text exceeds byte limit");
  return {
    id: expectPattern(record.id, `${path}.id`, SAFE_ID, 128),
    revision: expectInteger(record.revision, `${path}.revision`, 1, 2_147_483_647),
    objective: expectString(record.objective, `${path}.objective`, 1, 8192),
    checkpoint: expectString(record.checkpoint, `${path}.checkpoint`, 1, 8192),
    constraints,
    frames,
  };
}

function parseTarget(value: unknown, path: string): DispatchTarget {
  const record = asRecord(value, path);
  assertExactKeys(record, ["workspace_id", "checkout", "repository", "branch", "expected_head", "allowed_paths"], [], path);
  const allowedPaths = expectArray(record.allowed_paths, `${path}.allowed_paths`, 1024).map((item, index) =>
    expectRelativePath(item, `${path}.allowed_paths[${index}]`),
  );
  assertUnique(allowedPaths, `${path}.allowed_paths`);
  return {
    workspace_id: expectPattern(record.workspace_id, `${path}.workspace_id`, SAFE_ID, 128),
    checkout: expectRelativePath(record.checkout, `${path}.checkout`),
    repository: expectPattern(record.repository, `${path}.repository`, REPOSITORY, 200),
    branch: expectString(record.branch, `${path}.branch`, 1, 255),
    expected_head: expectPattern(record.expected_head, `${path}.expected_head`, GIT_SHA1, 40),
    allowed_paths: allowedPaths,
  };
}

function parseStdin(value: unknown, path: string): StdinSpec {
  const record = asRecord(value, path);
  assertExactKeys(record, ["mode"], ["text"], path);
  const mode = expectOneOf(record.mode, ["none", "literal", "context_bundle"] as const, `${path}.mode`);
  if (mode === "literal") {
    return { mode, text: expectString(record.text, `${path}.text`, 0, 131_072) };
  }
  if ("text" in record) throw new ValidationError(`${path}.text`, `is not allowed for ${mode}`);
  return { mode };
}

function parseStep(value: unknown, path: string): ToolStep {
  const record = asRecord(value, path);
  assertExactKeys(record, ["id", "tool_id", "args", "cwd", "stdin"], ["timeout_ms"], path);
  const args = expectArray(record.args, `${path}.args`, 128).map((item, index) =>
    expectString(item, `${path}.args[${index}]`, 0, 4096),
  );
  const timeout = record.timeout_ms === undefined
    ? undefined
    : expectInteger(record.timeout_ms, `${path}.timeout_ms`, 1000, 86_400_000);
  return {
    id: expectPattern(record.id, `${path}.id`, SAFE_ID, 128),
    tool_id: expectPattern(record.tool_id, `${path}.tool_id`, SAFE_ID, 128),
    args,
    cwd: expectRelativePath(record.cwd, `${path}.cwd`),
    stdin: parseStdin(record.stdin, `${path}.stdin`),
    ...(timeout === undefined ? {} : { timeout_ms: timeout }),
  };
}

function parseDispatch(value: unknown): Dispatch {
  const record = asRecord(value, "$");
  assertExactKeys(
    record,
    ["version", "dispatch_id", "issued_at", "expires_at", "context", "target", "operation", "requested_capabilities", "reporting"],
    [],
    "$",
  );
  if (record.version !== 1) throw new ValidationError("$.version", "must equal 1");
  const operation = asRecord(record.operation, "$.operation");
  assertExactKeys(operation, ["kind", "steps"], [], "$.operation");
  if (operation.kind !== "tool_sequence") throw new ValidationError("$.operation.kind", "must equal tool_sequence");
  const steps = expectArray(operation.steps, "$.operation.steps", 64, 1).map((item, index) =>
    parseStep(item, `$.operation.steps[${index}]`),
  );
  assertUnique(steps.map((step) => step.id), "$.operation.steps");

  const capabilities = expectArray(record.requested_capabilities, "$.requested_capabilities", 16, 1).map((item, index) =>
    expectOneOf(item, CAPABILITIES, `$.requested_capabilities[${index}]`) as Capability,
  );
  assertUnique(capabilities, "$.requested_capabilities");

  const reporting = asRecord(record.reporting, "$.reporting");
  assertExactKeys(
    reporting,
    ["minimum_update_interval_seconds", "maximum_silence_seconds", "include_context_handoff"],
    [],
    "$.reporting",
  );
  const minimumUpdate = expectInteger(reporting.minimum_update_interval_seconds, "$.reporting.minimum_update_interval_seconds", 30, 3600);
  const maximumSilence = expectInteger(reporting.maximum_silence_seconds, "$.reporting.maximum_silence_seconds", 60, 86_400);
  if (maximumSilence < minimumUpdate) {
    throw new ValidationError("$.reporting.maximum_silence_seconds", "must not be shorter than minimum update interval");
  }

  return {
    version: 1,
    dispatch_id: expectPattern(record.dispatch_id, "$.dispatch_id", SAFE_ID, 128),
    issued_at: expectDateTime(record.issued_at, "$.issued_at"),
    expires_at: expectDateTime(record.expires_at, "$.expires_at"),
    context: parseContext(record.context, "$.context"),
    target: parseTarget(record.target, "$.target"),
    operation: { kind: "tool_sequence", steps },
    requested_capabilities: capabilities,
    reporting: {
      minimum_update_interval_seconds: minimumUpdate,
      maximum_silence_seconds: maximumSilence,
      include_context_handoff: expectBoolean(reporting.include_context_handoff, "$.reporting.include_context_handoff"),
    },
  };
}

export function parseDispatchEnvelope(body: string): ParsedDispatch | null {
  const payloadText = extractDispatchPayload(body);
  if (payloadText === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown JSON error";
    throw new ValidationError("$", `invalid JSON: ${message}`);
  }
  const dispatch = parseDispatch(decoded);
  const issued = Date.parse(dispatch.issued_at);
  const expires = Date.parse(dispatch.expires_at);
  if (expires <= issued) throw new ValidationError("$.expires_at", "must be later than issued_at");
  return { dispatch, payloadText, payloadSha256: sha256Utf8(payloadText) };
}

export interface TimeWindowPolicy {
  readonly maximumClockSkewMs: number;
  readonly maximumLifetimeMs: number;
}

export function validateDispatchTimeWindow(
  dispatch: Dispatch,
  now: Date,
  policy: TimeWindowPolicy = { maximumClockSkewMs: 300_000, maximumLifetimeMs: 86_400_000 },
): void {
  const issued = Date.parse(dispatch.issued_at);
  const expires = Date.parse(dispatch.expires_at);
  if (issued > now.getTime() + policy.maximumClockSkewMs) {
    throw new ValidationError("$.issued_at", "is too far in the future");
  }
  if (expires <= now.getTime()) throw new ValidationError("$.expires_at", "dispatch has expired");
  if (expires - issued > policy.maximumLifetimeMs) {
    throw new ValidationError("$.expires_at", "dispatch lifetime exceeds local policy");
  }
}
