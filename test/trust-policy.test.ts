import assert from "node:assert/strict";
import test from "node:test";

import type { MailboxConfig } from "../src/config/model.js";
import { TrustPolicy, TrustPolicyError } from "../src/application/trust-policy.js";
import type { SourceComment } from "../src/domain/model.js";

const mailbox: MailboxConfig = {
  id: "control",
  repository: "iteathen/PATCH-POLLER",
  issueNumber: 1,
  trustedAuthors: ["iteathen"],
  trustedAppIds: [42],
  allowedAuthorAssociations: ["OWNER"],
  bootstrap: "ignore_existing",
};

function comment(overrides: Partial<SourceComment> = {}): SourceComment {
  return {
    repository: mailbox.repository,
    issueNumber: mailbox.issueNumber,
    id: 1,
    nodeId: "IC_test",
    body: "",
    authorLogin: "iteathen",
    authorAssociation: "OWNER",
    createdAt: "2026-08-17T22:00:00.000Z",
    updatedAt: "2026-08-17T22:00:00.000Z",
    htmlUrl: "https://github.com/iteathen/PATCH-POLLER/issues/1#issuecomment-1",
    ...overrides,
  };
}

test("accepts locally trusted human or app identity", () => {
  const policy = new TrustPolicy();
  policy.validateSource(comment(), mailbox);
  policy.validateSource(comment({ authorLogin: "bot", authorAssociation: "NONE", appId: 42 }), mailbox);
});

test("rejects untrusted source before parsing remote instructions", () => {
  const policy = new TrustPolicy();
  assert.throws(
    () => policy.validateSource(comment({ authorLogin: "attacker", authorAssociation: "NONE" }), mailbox),
    (error: unknown) => error instanceof TrustPolicyError && error.code === "UNTRUSTED_SOURCE",
  );
});
