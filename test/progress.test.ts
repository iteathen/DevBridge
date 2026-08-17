import assert from "node:assert/strict";
import test from "node:test";

import type { LifecycleReport } from "../src/domain/model.js";
import { applyProgressEvent, renderLifecycleComment, shouldProjectProgress } from "../src/domain/progress.js";

const initial: LifecycleReport = {
  version: 1,
  dispatch_id: "job-1",
  payload_sha256: "a".repeat(64),
  context_id: "context",
  context_revision: 1,
  source_comment: {
    repository: "iteathen/PATCH-POLLER",
    issue_number: 1,
    comment_id: 10,
    html_url: "https://github.com/iteathen/PATCH-POLLER/issues/1#issuecomment-10",
  },
  continuation: {
    objective: "Prove progress reporting.",
    checkpoint: "Accepted.",
    constraints: ["Do not invent next_step."],
    omitted_constraint_sha256: [],
    frames: [],
    omitted_frame_sha256: [],
  },
  attempt: 1,
  progress_sequence: 0,
  state: "accepted",
  phase: "accepted",
  started_at: "2026-08-17T22:00:00.000Z",
  updated_at: "2026-08-17T22:00:00.000Z",
  last_meaningful_activity_at: "2026-08-17T22:00:00.000Z",
  progress: { current_step: 0, total_steps: 2, last_completed_checkpoint: "" },
  bounded_summary: "Accepted.",
  rate_mode: "normal",
  evidence: [],
  changed_paths: [],
};

test("progress sequence is monotonic and updates material state", () => {
  const running = applyProgressEvent(initial, {
    sequence: 1,
    state: "running",
    phase: "tool",
    at: "2026-08-17T22:01:00.000Z",
    summary: "Running step one.",
    currentStep: 1,
    totalSteps: 2,
  }, "normal");
  assert.equal(running.state, "running");
  assert.equal(running.progress.current_step, 1);
  assert.throws(() => applyProgressEvent(running, {
    sequence: 1,
    state: "running",
    phase: "tool",
    at: "2026-08-17T22:01:01.000Z",
    summary: "duplicate",
  }, "normal"), /must increase/u);
});

test("coalesces rapid progress but always projects terminal state", () => {
  const running = applyProgressEvent(initial, {
    sequence: 1,
    state: "running",
    phase: "tool",
    at: "2026-08-17T22:00:10.000Z",
    summary: "Running.",
  }, "normal");
  const policy = { minimumUpdateIntervalMs: 60_000, maximumSilenceMs: 600_000 };
  assert.equal(shouldProjectProgress(initial, running, Date.parse(initial.updated_at), Date.parse(running.updated_at), policy), false);
  const done = applyProgressEvent(running, {
    sequence: 2,
    state: "completed",
    phase: "completed",
    at: "2026-08-17T22:00:11.000Z",
    summary: "Completed.",
  }, "normal");
  assert.equal(shouldProjectProgress(running, done, Date.parse(running.updated_at), Date.parse(done.updated_at), policy), true);
});

test("renders one human and machine-readable lifecycle comment", () => {
  const body = renderLifecycleComment(initial);
  assert.match(body, /PATCH-POLLER — accepted/u);
  assert.match(body, /PATCH-POLLER-REPORT v1/u);
  assert.match(body, /"dispatch_id":"job-1"/u);
  assert.match(body, /"continuation"/u);
});
