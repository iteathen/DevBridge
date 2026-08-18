import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitHubBudgetUnavailableError,
  GitHubRestClient,
} from "../src/adapters/github/github-rest-client.js";
import { SqliteStateStore } from "../src/adapters/state/sqlite-state-store.js";
import { RateBudgetGovernor } from "../src/domain/rate-budget.js";
import type { Clock } from "../src/ports/clock.js";
import type { Logger } from "../src/ports/logger.js";

class FakeClock implements Clock {
  readonly sleeps: number[] = [];

  constructor(public nowMs = 1_000_000) {}

  now(): Date {
    return new Date(this.nowMs);
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new Error("aborted");
    this.sleeps.push(milliseconds);
    this.nowMs += milliseconds;
  }
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const budgetConfig = {
  activeIntervalMs: 30_000,
  idleIntervalMs: 120_000,
  maximumIdleIntervalMs: 900_000,
  conservationRemaining: 750,
  criticalReserveRemaining: 200,
  conservationRatio: 0.2,
};

function rateHeaders(remaining = 4999): Record<string, string> {
  return {
    "x-ratelimit-resource": "core",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-used": String(5000 - remaining),
    "x-ratelimit-reset": "5000",
    date: "Thu, 01 Jan 1970 00:16:40 GMT",
  };
}

function withState(run: (state: SqliteStateStore) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "patch-poller-github-"));
  const state = new SqliteStateStore(path.join(directory, "state.sqlite"));
  state.initialize();
  return run(state).finally(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

test("preserves an enterprise API base path and sends conditional headers", async () => {
  await withState(async (state) => {
    const clock = new FakeClock();
    const governor = new RateBudgetGovernor(budgetConfig);
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new GitHubRestClient({
      apiBaseUrl: "https://github.example/api/v3",
      apiVersion: "2026-03-10",
      token: "test-token",
      userAgent: "patch-poller/test",
    }, governor, clock, logger, state, async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("[]", {
        status: 200,
        headers: { ...rateHeaders(), etag: "\"mailbox-v1\"" },
      });
    });

    const response = await client.request<unknown[]>(
      "GET",
      "/repos/iteathen/PATCH-POLLER/issues/1/comments",
      "background",
      {
        purpose: "conditional test",
        conditional: { etag: "\"previous\"", lastModified: "Wed, 31 Dec 1969 23:59:59 GMT" },
      },
    );

    assert.equal(calls[0]?.url, "https://github.example/api/v3/repos/iteathen/PATCH-POLLER/issues/1/comments");
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("if-none-match"), "\"previous\"");
    assert.equal(headers.get("if-modified-since"), "Wed, 31 Dec 1969 23:59:59 GMT");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    assert.equal(headers.get("authorization"), "Bearer test-token");
    assert.equal(response.etag, "\"mailbox-v1\"");
    assert.equal(state.getRateSnapshots()[0]?.remaining, 4999);
  });
});

test("denies conservation probes locally until the stored reset deadline", async () => {
  await withState(async (state) => {
    const clock = new FakeClock();
    const governor = new RateBudgetGovernor(budgetConfig);
    governor.restore({
      resource: "core",
      limit: 5000,
      remaining: 700,
      used: 4300,
      resetAtMs: 2_000_000,
      observedAtMs: clock.nowMs,
    });
    let fetchCalls = 0;
    const client = new GitHubRestClient({
      apiBaseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      token: "test-token",
      userAgent: "patch-poller/test",
    }, governor, clock, logger, state, async () => {
      fetchCalls += 1;
      return new Response("[]", { status: 200, headers: rateHeaders() });
    });

    await assert.rejects(
      client.request("GET", "/repos/a/b/issues/1/comments", "background", { purpose: "budget test" }),
      (error: unknown) => error instanceof GitHubBudgetUnavailableError && error.retryAtMs === 2_000_000,
    );
    assert.equal(fetchCalls, 0);
  });
});

test("serializes mutations and spaces them by at least one second", async () => {
  await withState(async (state) => {
    const clock = new FakeClock();
    const governor = new RateBudgetGovernor(budgetConfig);
    const order: string[] = [];
    const client = new GitHubRestClient({
      apiBaseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      token: "test-token",
      userAgent: "patch-poller/test",
    }, governor, clock, logger, state, async (_input, init) => {
      order.push(String(init?.body));
      return new Response(JSON.stringify({ id: order.length }), {
        status: 201,
        headers: rateHeaders(4990 - order.length),
      });
    });

    await Promise.all([
      client.request("POST", "/repos/a/b/issues/1/comments", "normal", {
        purpose: "first mutation",
        body: { body: "first" },
      }),
      client.request("POST", "/repos/a/b/issues/1/comments", "normal", {
        purpose: "second mutation",
        body: { body: "second" },
      }),
    ]);

    assert.deepEqual(order, [JSON.stringify({ body: "first" }), JSON.stringify({ body: "second" })]);
    assert(clock.sleeps.some((milliseconds) => milliseconds >= 1000));
  });
});

test("rejects pagination URLs outside the configured API origin", async () => {
  await withState(async (state) => {
    const client = new GitHubRestClient({
      apiBaseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      token: "test-token",
      userAgent: "patch-poller/test",
    }, new RateBudgetGovernor(budgetConfig), new FakeClock(), logger, state, async () => {
      throw new Error("fetch must not be reached");
    });
    await assert.rejects(
      client.request("GET", "https://attacker.example/repos/a/b", "background", { purpose: "origin guard" }),
      /escaped the configured API base/u,
    );
  });
});
