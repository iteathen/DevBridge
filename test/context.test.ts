import assert from "node:assert/strict";
import test from "node:test";

import { buildContinuationContext } from "../src/domain/context.js";
import { sha256Utf8 } from "../src/domain/dispatch.js";

function frame(id: string, trust: "trusted_instruction" | "observed_evidence", text: string) {
  return {
    id,
    kind: trust === "trusted_instruction" ? "constraint" as const : "evidence" as const,
    trust,
    text,
    source: { kind: "controller" as const, reference: id },
    sha256: sha256Utf8(text),
  };
}

test("continuation context preserves trusted authority before bulky evidence", () => {
  const trusted = frame("trusted", "trusted_instruction", "Primary controller owns next_step.");
  const evidence = frame("evidence", "observed_evidence", "e".repeat(20_000));
  const result = buildContinuationContext({
    id: "context",
    revision: 1,
    objective: "Continue safely.",
    checkpoint: "Transport ready.",
    constraints: ["Never use Python."],
    frames: [evidence, trusted],
  }, 8192);
  assert.equal(result.frames[0]?.id, "trusted");
  assert(result.omitted_frame_sha256.includes(evidence.sha256));
});
