import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteStateStore } from "../src/adapters/state/sqlite-state-store.js";
import { parseDispatchEnvelope, sha256Utf8 } from "../src/domain/dispatch.js";
import type { LifecycleReport, ParsedDispatch, SourceComment } from "../src/domain/model.js";

function parsedDispatch(): ParsedDispatch {
  const payload = {
    version: 1,
    dispatch_id: "recovery-read-only",
    issued_at: "2030-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T01:00:00.000Z",
    context: {
      id: "recovery-context",
      revision: 1,
      objective: "Prove durable read-only restart recovery.",
      checkpoint: "Dispatch is ready to claim.",
      constraints: ["Do not write to the checkout."],
      frames: [],
    },
    target: {
      workspace_id: "projects",
      checkout: "PATCH-POLLER",
      repository: "iteathen/PATCH-POLLER",
      branch: "main",
      expected_head: "0123456789abcdef0123456789abcdef01234567",
      allowed_paths: [],
    },
    operation: {
      kind: "tool_sequence",
      steps: [{
        id: "node-version",
        tool_id: "node-version",
        args: [],
        cwd: ".",
        stdin: { mode: "none" },
      }],
    },
    requested_capabilities: ["workspace.read", "process.execute", "github.report"],
    reporting: {
      minimum_update_interval_seconds: 60,
      maximum_silence_seconds: 600,
      include_context_handoff: true,
    },
  };
  const parsed = parseDispatchEnvelope(
    `<!-- PATCH-POLLER-DISPATCH v1\n${JSON.stringify(payload)}\n-->`,
  );
  if (parsed === null) throw new Error("recovery fixture did not parse");
  return parsed;
}

function sourceComment(parsed: ParsedDispatch): SourceComment {
  return {
    repository: "iteathen/PATCH-POLLER",
    issueNumber: 1,
    id: 500,
    nodeId: "IC_500",
    body: parsed.payloadText,
    authorLogin: "iteathen",
    authorAssociation: "OWNER",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    htmlUrl: "https://github.com/iteathen/PATCH-POLLER/issues/1#issuecomment-500",
  };
}

function report(
  parsed: ParsedDispatch,
  attempt: number,
  sequence: number,
  state: "running" | "completed",
): LifecycleReport {
  const updatedAt = state === "running"
    ? "2030-01-01T00:10:00.000Z"
    : "2030-01-01T00:20:00.000Z";
  return {
    version: 1,
    dispatch_id: parsed.dispatch.dispatch_id,
    payload_sha256: parsed.payloadSha256,
    context_id: parsed.dispatch.context.id,
    context_revision: parsed.dispatch.context.revision,
    source_comment: {
      repository: "iteathen/PATCH-POLLER",
      issue_number: 1,
      comment_id: 500,
      html_url: "https://github.com/iteathen/PATCH-POLLER/issues/1#issuecomment-500",
    },
    continuation: {
      objective: parsed.dispatch.context.objective,
      checkpoint: parsed.dispatch.context.checkpoint,
      constraints: parsed.dispatch.context.constraints,
      omitted_constraint_sha256: [],
      frames: [],
      omitted_frame_sha256: [],
    },
    attempt,
    progress_sequence: sequence,
    state,
    phase: state,
    started_at: "2030-01-01T00:00:00.000Z",
    updated_at: updatedAt,
    last_meaningful_activity_at: updatedAt,
    ...(state === "completed" ? { completed_at: updatedAt } : {}),
    progress: {
      current_step: 1,
      total_steps: 1,
      last_completed_checkpoint: state,
    },
    bounded_summary: state,
    rate_mode: "normal",
    evidence: [`attempt ${attempt}`],
    ...(state === "completed"
      ? {
          final_head: parsed.dispatch.target.expected_head,
          handoff: {
            summary: "Read-only work completed.",
            completed: ["node-version"],
            remaining: [],
            constraints: parsed.dispatch.context.constraints,
            evidence: [`attempt ${attempt}`],
            controller_decision_needed: "Primary controller chooses next_step.",
          },
        }
      : {}),
    changed_paths: [],
  };
}

test("nonterminal same-payload work resumes and terminal work deduplicates", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "patch-poller-recovery-"));
  const store = new SqliteStateStore(path.join(directory, "state.sqlite"));
  store.initialize();
  try {
    const parsed = parsedDispatch();
    const comment = sourceComment(parsed);
    assert.equal(store.markSourceCommentSeen(comment, sha256Utf8(comment.body)), "new");

    assert.deepEqual(store.claimDispatch(comment, parsed), { status: "claimed", attempt: 1 });
    store.saveLifecycleReport(report(parsed, 1, 5, "running"));

    assert.equal(store.markSourceCommentSeen(comment, sha256Utf8(comment.body)), "same");
    assert.deepEqual(store.claimDispatch(comment, parsed), { status: "claimed", attempt: 2 });
    assert.equal(store.getLifecycleReport(parsed.dispatch.dispatch_id)?.progress_sequence, 5);

    store.saveLifecycleReport(report(parsed, 2, 6, "completed"));
    assert.deepEqual(store.claimDispatch(comment, parsed), { status: "duplicate" });
    assert.equal(store.getLifecycleReport(parsed.dispatch.dispatch_id)?.state, "completed");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
