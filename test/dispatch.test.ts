import assert from "node:assert/strict";
import test from "node:test";

import { parseDispatchEnvelope, sha256Utf8, validateDispatchTimeWindow } from "../src/domain/dispatch.js";
import { ValidationError } from "../src/domain/validation.js";

function validBody(overrides: Record<string, unknown> = {}): string {
  const frameText = "Primary controller owns next_step.";
  const dispatch = {
    version: 1,
    dispatch_id: "bootstrap-1",
    issued_at: "2026-08-17T22:00:00.000Z",
    expires_at: "2026-08-18T22:00:00.000Z",
    context: {
      id: "bootstrap",
      revision: 1,
      objective: "Prove the protocol parser.",
      checkpoint: "Repository initialized.",
      constraints: ["Never use Python."],
      frames: [
        {
          id: "authority-1",
          kind: "constraint",
          trust: "trusted_instruction",
          text: frameText,
          source: { kind: "controller", reference: "test" },
          sha256: sha256Utf8(frameText)
        }
      ]
    },
    target: {
      workspace_id: "projects",
      checkout: "PATCH-POLLER",
      repository: "iteathen/PATCH-POLLER",
      branch: "main",
      expected_head: "0123456789abcdef0123456789abcdef01234567",
      allowed_paths: []
    },
    operation: {
      kind: "tool_sequence",
      steps: [
        {
          id: "version",
          tool_id: "node-version",
          args: [],
          cwd: "PATCH-POLLER",
          stdin: { mode: "none" }
        }
      ]
    },
    requested_capabilities: ["workspace.read", "process.execute", "github.report"],
    reporting: {
      minimum_update_interval_seconds: 60,
      maximum_silence_seconds: 600,
      include_context_handoff: true
    },
    ...overrides
  };
  return `before\n<!-- PATCH-POLLER-DISPATCH v1\n${JSON.stringify(dispatch)}\n-->\nafter`;
}

test("parses exactly one strict dispatch envelope", () => {
  const parsed = parseDispatchEnvelope(validBody());
  assert(parsed);
  assert.equal(parsed.dispatch.dispatch_id, "bootstrap-1");
  assert.equal(parsed.dispatch.context.frames[0]?.trust, "trusted_instruction");
  assert.match(parsed.payloadSha256, /^[0-9a-f]{64}$/u);
});

test("ignores comments without a dispatch marker", () => {
  assert.equal(parseDispatchEnvelope("ordinary comment"), null);
});

test("rejects unknown properties", () => {
  assert.throws(() => parseDispatchEnvelope(validBody({ surprise: true })), ValidationError);
});

test("rejects frame digest mismatch", () => {
  const body = validBody();
  const tampered = body.replace(sha256Utf8("Primary controller owns next_step."), "0".repeat(64));
  assert.throws(() => parseDispatchEnvelope(tampered), /does not match frame text/u);
});

test("validates expiry and bounded lifetime", () => {
  const parsed = parseDispatchEnvelope(validBody());
  assert(parsed);
  validateDispatchTimeWindow(parsed.dispatch, new Date("2026-08-17T23:00:00.000Z"));
  assert.throws(
    () => validateDispatchTimeWindow(parsed.dispatch, new Date("2026-08-19T00:00:00.000Z")),
    /expired/u,
  );
});
