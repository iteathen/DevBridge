import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteStateStore } from "../src/adapters/state/sqlite-state-store.js";
import { parseDispatchEnvelope, sha256Utf8 } from "../src/domain/dispatch.js";
import type { SourceComment } from "../src/domain/model.js";

function source(body: string): SourceComment {
  return {
    repository: "iteathen/PATCH-POLLER",
    issueNumber: 1,
    id: 123,
    nodeId: "IC_test",
    body,
    authorLogin: "iteathen",
    authorAssociation: "OWNER",
    createdAt: "2026-08-17T22:00:00.000Z",
    updatedAt: "2026-08-17T22:00:00.000Z",
    htmlUrl: "https://github.com/iteathen/PATCH-POLLER/issues/1#issuecomment-123",
  };
}

function body(): string {
  const frame = "constraint";
  return `<!-- PATCH-POLLER-DISPATCH v1\n${JSON.stringify({
    version: 1,
    dispatch_id: "state-1",
    issued_at: "2026-08-17T22:00:00.000Z",
    expires_at: "2026-08-18T22:00:00.000Z",
    context: {
      id: "state-context",
      revision: 1,
      objective: "test",
      checkpoint: "test",
      constraints: [],
      frames: [{
        id: "f1",
        kind: "constraint",
        trust: "trusted_instruction",
        text: frame,
        source: { kind: "controller", reference: "test" },
        sha256: sha256Utf8(frame),
      }],
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
      steps: [{ id: "version", tool_id: "node-version", args: [], cwd: ".", stdin: { mode: "none" } }],
    },
    requested_capabilities: ["workspace.read", "process.execute", "github.report"],
    reporting: { minimum_update_interval_seconds: 60, maximum_silence_seconds: 600, include_context_handoff: true },
  })}\n-->`;
}

test("durably claims a dispatch once and detects edited replay", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "patch-poller-state-"));
  const store = new SqliteStateStore(path.join(directory, "state.sqlite"));
  try {
    store.initialize();
    const comment = source(body());
    const parsed = parseDispatchEnvelope(comment.body);
    assert(parsed);
    assert.equal(store.markSourceCommentSeen(comment, sha256Utf8(comment.body)), "new");
    assert.deepEqual(store.claimDispatch(comment, parsed), { status: "claimed", attempt: 1 });
    assert.deepEqual(store.claimDispatch(comment, parsed), { status: "duplicate" });

    const edited = source(comment.body.replace("state-1", "state-2"));
    const editedParsed = parseDispatchEnvelope(edited.body);
    assert(editedParsed);
    assert.equal(store.markSourceCommentSeen(edited, sha256Utf8(edited.body)), "edited");
    assert.deepEqual(store.claimDispatch(edited, editedParsed), { status: "comment_tampered" });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
