import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitHubRestClient } from "../src/adapters/github/github-rest-client.js";
import { IssueCommentMailbox } from "../src/adapters/github/issue-comment-mailbox.js";
import { SqliteStateStore } from "../src/adapters/state/sqlite-state-store.js";
import type { MailboxConfig } from "../src/config/model.js";
import { RateBudgetGovernor } from "../src/domain/rate-budget.js";
import type { Clock } from "../src/ports/clock.js";
import type { Logger } from "../src/ports/logger.js";

class FakeClock implements Clock {
  constructor(public nowMs = 1_000_000) {}

  now(): Date {
    return new Date(this.nowMs);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.nowMs += milliseconds;
  }
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const mailboxConfig: MailboxConfig = {
  id: "control",
  repository: "iteathen/PATCH-POLLER",
  issueNumber: 1,
  trustedAuthors: ["iteathen"],
  trustedAppIds: [],
  allowedAuthorAssociations: ["OWNER"],
  bootstrap: "ignore_existing",
};

function headers(etag: string): Record<string, string> {
  return {
    "x-ratelimit-resource": "core",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": "5000",
    "x-poll-interval": "60",
    date: "Thu, 01 Jan 1970 00:16:40 GMT",
    etag,
  };
}

test("bootstraps from server time, polls with only supported parameters, and reaches 304 steady state", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "patch-poller-mailbox-"));
  const state = new SqliteStateStore(path.join(directory, "state.sqlite"));
  state.initialize();
  try {
    const requests: { url: URL; init?: RequestInit }[] = [];
    const responses = [
      new Response("[]", { status: 200, headers: headers("\"baseline\"") }),
      new Response(JSON.stringify([{
        id: 101,
        node_id: "IC_101",
        body: "ordinary comment",
        user: { login: "iteathen" },
        author_association: "OWNER",
        created_at: "1970-01-01T00:16:41.000Z",
        updated_at: "1970-01-01T00:16:41.000Z",
        html_url: "https://github.com/iteathen/PATCH-POLLER/issues/1#issuecomment-101",
        performed_via_github_app: null,
      }]), { status: 200, headers: headers("\"changed\"") }),
      new Response("[]", { status: 200, headers: headers("\"steady\"") }),
      new Response(null, { status: 304, headers: headers("\"steady\"") }),
    ];
    const clock = new FakeClock();
    const governor = new RateBudgetGovernor({
      activeIntervalMs: 30_000,
      idleIntervalMs: 120_000,
      maximumIdleIntervalMs: 900_000,
      conservationRemaining: 750,
      criticalReserveRemaining: 200,
      conservationRatio: 0.2,
    });
    const client = new GitHubRestClient({
      apiBaseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      token: "test-token",
      userAgent: "patch-poller/test",
    }, governor, clock, logger, state, async (input, init) => {
      requests.push({ url: new URL(String(input)), ...(init === undefined ? {} : { init }) });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected mailbox request");
      return response;
    });
    const mailbox = new IssueCommentMailbox(mailboxConfig, client, state, clock);

    const baseline = await mailbox.poll();
    assert.equal(baseline.comments.length, 0);
    assert.equal(requests[0]?.url.searchParams.get("per_page"), "1");
    assert.equal(requests[0]?.url.searchParams.has("since"), false);

    const changed = await mailbox.poll();
    assert.equal(changed.comments[0]?.id, 101);
    assert.equal(requests[1]?.url.searchParams.get("per_page"), "100");
    assert.equal(requests[1]?.url.searchParams.get("since"), "1970-01-01T00:16:39.000Z");
    assert.equal(requests[1]?.url.searchParams.has("sort"), false);
    assert.equal(requests[1]?.url.searchParams.has("direction"), false);

    const steady = await mailbox.poll();
    assert.equal(steady.comments.length, 0);
    const notModified = await mailbox.poll();
    assert.equal(notModified.notModified, true);
    const finalHeaders = new Headers(requests[3]?.init?.headers);
    assert.equal(finalHeaders.get("if-none-match"), "\"steady\"");
    assert.equal(state.getMailboxCache("control").xPollIntervalSeconds, 60);
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
