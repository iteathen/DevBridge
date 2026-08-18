import assert from "node:assert/strict";
import test from "node:test";

import { renderRejectionFeedback } from "../src/application/rejection-feedback.js";
import type { SourceComment } from "../src/domain/model.js";

const comment: SourceComment = {
  repository: "iteathen/PATCH-POLLER",
  issueNumber: 1,
  id: 700,
  nodeId: "IC_700",
  body: "invalid dispatch",
  authorLogin: "iteathen",
  authorAssociation: "OWNER",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  htmlUrl: "https://github.com/iteathen/PATCH-POLLER/issues/1#issuecomment-700",
};

test("trusted rejection feedback is bounded and machine-readable", () => {
  const body = renderRejectionFeedback(
    comment,
    "INVALID_DISPATCH",
    `bounded reason: ${"x".repeat(10_000)}`,
    "2030-01-01T00:01:00.000Z",
    "dispatch-700",
  );
  assert.match(body, /PATCH-POLLER — dispatch rejected/u);
  assert.match(body, /PATCH-POLLER-REJECTION v1/u);
  assert.match(body, /"comment_id":700/u);
  assert.match(body, /"dispatch_id":"dispatch-700"/u);
  assert(Buffer.byteLength(body, "utf8") < 16_384);
  assert.doesNotMatch(body, /x{5000}/u);
});
