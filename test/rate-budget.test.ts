import assert from "node:assert/strict";
import test from "node:test";

import { RateBudgetGovernor, parseRateSnapshot } from "../src/domain/rate-budget.js";

const config = {
  activeIntervalMs: 30_000,
  idleIntervalMs: 120_000,
  maximumIdleIntervalMs: 900_000,
  conservationRemaining: 750,
  criticalReserveRemaining: 200,
  conservationRatio: 0.2,
};

test("parses rate headers and enters conservation modes", () => {
  const governor = new RateBudgetGovernor(config);
  governor.observe({
    "x-ratelimit-resource": "core",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "700",
    "x-ratelimit-used": "4300",
    "x-ratelimit-reset": "2000",
  }, 1_000_000);
  assert.equal(governor.mode(1_000_000), "conserve");
  assert.equal(governor.canRequest("background", 1_000_000), false);
  assert.equal(governor.canRequest("normal", 1_000_000), true);

  governor.observe({
    "x-ratelimit-resource": "core",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "150",
    "x-ratelimit-used": "4850",
    "x-ratelimit-reset": "2000",
  }, 1_000_001);
  assert.equal(governor.mode(1_000_001), "terminal_only");
  assert.equal(governor.canRequest("normal", 1_000_001), false);
  assert.equal(governor.canRequest("critical", 1_000_001), true);
});

test("zero remaining blocks every request until reset", () => {
  const governor = new RateBudgetGovernor(config);
  governor.restore({
    resource: "core",
    limit: 5000,
    remaining: 0,
    used: 5000,
    resetAtMs: 2_000_000,
    observedAtMs: 1_000_000,
  });
  assert.equal(governor.mode(1_500_000), "blocked");
  assert.equal(governor.canRequest("critical", 1_500_000), false);
  assert.equal(governor.mode(2_000_000), "normal");
});

test("authenticated 304-compatible polling backs off adaptively and honors floor", () => {
  const governor = new RateBudgetGovernor(config);
  assert.equal(governor.pollDelayMs(0, undefined, 0), 30_000);
  assert.equal(governor.pollDelayMs(1, undefined, 0), 120_000);
  assert.equal(governor.pollDelayMs(4, undefined, 0), 900_000);
  assert.equal(governor.pollDelayMs(0, 60, 0), 60_000);
});

test("rate-limit retry obeys retry-after then reset then exponential fallback", () => {
  const governor = new RateBudgetGovernor(config);
  assert.equal(governor.rateLimitRetryAtMs(429, { "retry-after": "120" }, 1_000, 0), 121_000);
  assert.equal(governor.rateLimitRetryAtMs(403, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "500",
  }, 1_000, 0), 500_000);
  assert.equal(governor.rateLimitRetryAtMs(403, {}, 1_000, 2), 241_000);
  assert.equal(governor.rateLimitRetryAtMs(500, {}, 1_000, 0), undefined);
});

test("rejects incomplete rate snapshots", () => {
  assert.equal(parseRateSnapshot({ "x-ratelimit-limit": "5000" }, 0), undefined);
});
