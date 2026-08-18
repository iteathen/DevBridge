import { RateLimitError } from '../errors.js';

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function integerHeader(headers, name) {
  const raw = headerValue(headers, name);
  if (raw == null || raw === '') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

export class RateBudget {
  #reserveRatio;
  #minimumReserve;
  #emergencyReserve;
  #snapshot = {
    limit: null,
    remaining: null,
    used: null,
    resetAt: null,
    resource: null,
    pollIntervalMs: null
  };

  constructor({ reserveRatio = 0.2, minimumReserve = 250, emergencyReserve = 25 } = {}) {
    this.#reserveRatio = reserveRatio;
    this.#minimumReserve = minimumReserve;
    this.#emergencyReserve = emergencyReserve;
  }

  record(headers) {
    const limit = integerHeader(headers, 'x-ratelimit-limit');
    const remaining = integerHeader(headers, 'x-ratelimit-remaining');
    const used = integerHeader(headers, 'x-ratelimit-used');
    const resetSeconds = integerHeader(headers, 'x-ratelimit-reset');
    const pollSeconds = integerHeader(headers, 'x-poll-interval');

    if (limit != null) this.#snapshot.limit = limit;
    if (remaining != null) this.#snapshot.remaining = remaining;
    if (used != null) this.#snapshot.used = used;
    if (resetSeconds != null) this.#snapshot.resetAt = resetSeconds * 1000;
    this.#snapshot.resource = headerValue(headers, 'x-ratelimit-resource') ?? this.#snapshot.resource;
    if (pollSeconds != null) this.#snapshot.pollIntervalMs = pollSeconds * 1000;
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.#snapshot);
  }

  reserveFloor({ critical = false } = {}) {
    if (critical) return this.#emergencyReserve;
    const proportional = this.#snapshot.limit == null ? 0 : Math.ceil(this.#snapshot.limit * this.#reserveRatio);
    return Math.max(this.#minimumReserve, proportional, this.#emergencyReserve);
  }

  recommendedPollIntervalMs(configuredMs, {
    now = Date.now(),
    estimatedRequestsPerCycle = 2,
  } = {}) {
    if (!Number.isInteger(configuredMs) || configuredMs < 1_000) throw new TypeError('configured polling interval must be an integer >= 1000 ms');
    if (!Number.isInteger(estimatedRequestsPerCycle) || estimatedRequestsPerCycle < 1 || estimatedRequestsPerCycle > 100) {
      throw new TypeError('estimatedRequestsPerCycle must be an integer between 1 and 100');
    }

    let recommended = Math.max(configuredMs, this.#snapshot.pollIntervalMs ?? 0);
    const { remaining, resetAt } = this.#snapshot;
    if (remaining == null || resetAt == null || resetAt <= now) return recommended;

    const windowMs = resetAt - now;
    const spendable = Math.max(0, remaining - this.reserveFloor());
    const safeCycles = Math.floor(spendable / estimatedRequestsPerCycle);
    if (safeCycles <= 0) return Math.max(recommended, windowMs);

    const sustainableIntervalMs = Math.ceil(windowMs / safeCycles);
    recommended = Math.max(recommended, sustainableIntervalMs);
    return recommended;
  }

  assertCanRequest({ critical = false, now = Date.now() } = {}) {
    if (this.#snapshot.resetAt != null && now >= this.#snapshot.resetAt) {
      this.#snapshot.remaining = null;
      this.#snapshot.used = null;
      this.#snapshot.resetAt = null;
      return;
    }

    if (this.#snapshot.remaining == null) return;
    const floor = this.reserveFloor({ critical });
    if (this.#snapshot.remaining <= floor) {
      throw new RateLimitError(
        `GitHub API reserve protected: remaining=${this.#snapshot.remaining}, floor=${floor}`,
        { retryAt: this.#snapshot.resetAt }
      );
    }
  }

  static retryAtFromResponse(response, now = Date.now()) {
    const retryAfter = integerHeader(response.headers, 'retry-after');
    if (retryAfter != null) return now + retryAfter * 1000;

    const remaining = integerHeader(response.headers, 'x-ratelimit-remaining');
    const resetSeconds = integerHeader(response.headers, 'x-ratelimit-reset');
    if (remaining === 0 && resetSeconds != null) return resetSeconds * 1000;

    return now + 60_000;
  }
}

export { headerValue };
