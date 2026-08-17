import type { RateMode } from "./model.js";

export type RequestPriority = "background" | "normal" | "critical";

export interface RateBudgetConfig {
  readonly activeIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly maximumIdleIntervalMs: number;
  readonly conservationRemaining: number;
  readonly criticalReserveRemaining: number;
  readonly conservationRatio: number;
}

export interface RateSnapshot {
  readonly resource: string;
  readonly limit: number;
  readonly remaining: number;
  readonly used: number;
  readonly resetAtMs: number;
  readonly observedAtMs: number;
}

export interface RateHeaders {
  readonly [name: string]: string | undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseRateSnapshot(headers: RateHeaders, nowMs: number): RateSnapshot | undefined {
  const limit = parseInteger(headers["x-ratelimit-limit"]);
  const remaining = parseInteger(headers["x-ratelimit-remaining"]);
  const used = parseInteger(headers["x-ratelimit-used"]);
  const resetSeconds = parseInteger(headers["x-ratelimit-reset"]);
  if (limit === undefined || remaining === undefined || used === undefined || resetSeconds === undefined) {
    return undefined;
  }
  return {
    resource: headers["x-ratelimit-resource"] ?? "unknown",
    limit,
    remaining,
    used,
    resetAtMs: resetSeconds * 1000,
    observedAtMs: nowMs,
  };
}

export class RateBudgetGovernor {
  #snapshot?: RateSnapshot;
  #blockedUntilMs = 0;
  #lastMutationAtMs = Number.NEGATIVE_INFINITY;

  constructor(readonly config: RateBudgetConfig) {
    if (config.criticalReserveRemaining >= config.conservationRemaining) {
      throw new Error("critical reserve must be lower than conservation threshold");
    }
  }

  observe(headers: RateHeaders, nowMs: number): RateSnapshot | undefined {
    const snapshot = parseRateSnapshot(headers, nowMs);
    if (snapshot !== undefined) this.restore(snapshot);
    return snapshot;
  }

  restore(snapshot: RateSnapshot): void {
    if (this.#snapshot === undefined || snapshot.observedAtMs >= this.#snapshot.observedAtMs) {
      this.#snapshot = snapshot;
    }
  }

  snapshot(): RateSnapshot | undefined {
    return this.#snapshot;
  }

  blockUntil(whenMs: number): void {
    if (!Number.isFinite(whenMs)) throw new Error("rate block deadline must be finite");
    this.#blockedUntilMs = Math.max(this.#blockedUntilMs, whenMs);
  }

  mode(nowMs: number): RateMode {
    if (nowMs < this.#blockedUntilMs) return "blocked";
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return "normal";
    if (snapshot.remaining === 0) {
      return nowMs < snapshot.resetAtMs ? "blocked" : "normal";
    }
    if (snapshot.remaining <= this.config.criticalReserveRemaining) return "terminal_only";
    const ratio = snapshot.limit === 0 ? 0 : snapshot.remaining / snapshot.limit;
    if (snapshot.remaining <= this.config.conservationRemaining || ratio <= this.config.conservationRatio) {
      return "conserve";
    }
    return "normal";
  }

  canRequest(priority: RequestPriority, nowMs: number): boolean {
    const mode = this.mode(nowMs);
    if (mode === "blocked") return false;
    if (priority === "critical") return true;
    if (mode === "terminal_only") return false;
    if (priority === "background" && mode === "conserve") return false;
    return true;
  }

  mutationDelayMs(nowMs: number): number {
    return Math.max(0, this.#lastMutationAtMs + 1000 - nowMs);
  }

  noteMutation(nowMs: number): void {
    this.#lastMutationAtMs = nowMs;
  }

  pollDelayMs(
    unchangedStreak: number,
    xPollIntervalSeconds: number | undefined,
    jitterFraction: number,
  ): number {
    const exponent = Math.min(Math.max(unchangedStreak - 1, 0), 4);
    const idle = this.config.idleIntervalMs * 2 ** exponent;
    const base = unchangedStreak === 0
      ? this.config.activeIntervalMs
      : Math.min(idle, this.config.maximumIdleIntervalMs);
    const floor = xPollIntervalSeconds === undefined ? 0 : xPollIntervalSeconds * 1000;
    const boundedJitter = Math.max(-0.25, Math.min(0.25, jitterFraction));
    return Math.max(floor, Math.round(base * (1 + boundedJitter)));
  }

  rateLimitRetryAtMs(
    status: number,
    headers: RateHeaders,
    nowMs: number,
    consecutiveSecondaryFailures: number,
  ): number | undefined {
    if (status !== 403 && status !== 429) return undefined;
    const retryAfter = parseInteger(headers["retry-after"]);
    if (retryAfter !== undefined) return nowMs + Math.max(1000, retryAfter * 1000);
    const remaining = parseInteger(headers["x-ratelimit-remaining"]);
    const reset = parseInteger(headers["x-ratelimit-reset"]);
    if (remaining === 0 && reset !== undefined) return Math.max(nowMs + 1000, reset * 1000);
    const exponent = Math.min(Math.max(consecutiveSecondaryFailures, 0), 6);
    return nowMs + Math.min(60_000 * 2 ** exponent, 3_600_000);
  }
}
