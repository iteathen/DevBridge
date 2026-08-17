import type { RateBudgetGovernor, RateHeaders, RequestPriority } from "../../domain/rate-budget.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { StateStore } from "../../ports/state-store.js";

export interface GitHubRestClientConfig {
  readonly apiBaseUrl: string;
  readonly apiVersion: string;
  readonly token: string;
  readonly userAgent: string;
  readonly maximumResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface ConditionalHeaders {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface GitHubResponse<T> {
  readonly status: number;
  readonly notModified: boolean;
  readonly data?: T;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly link?: string;
  readonly serverDate?: string;
  readonly xPollIntervalSeconds?: number;
}

export class GitHubBudgetUnavailableError extends Error {
  constructor(readonly priority: RequestPriority, readonly mode: string) {
    super(`GitHub budget unavailable for ${priority} request in ${mode} mode`);
    this.name = "GitHubBudgetUnavailableError";
  }
}

export class GitHubRateLimitedError extends Error {
  constructor(readonly retryAtMs: number, message: string) {
    super(message);
    this.name = "GitHubRateLimitedError";
  }
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function selectHeaders(headers: Headers): RateHeaders {
  const names = [
    "x-ratelimit-resource",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
    "x-ratelimit-reset",
    "retry-after",
    "x-poll-interval",
  ];
  const result: Record<string, string | undefined> = {};
  for (const name of names) result[name] = headers.get(name) ?? undefined;
  return result;
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function boundedApiMessage(status: number, text: string): string {
  let message = text;
  try {
    const decoded = JSON.parse(text) as { message?: unknown };
    if (typeof decoded.message === "string") message = decoded.message;
  } catch {
    // Preserve bounded raw response.
  }
  return `GitHub API ${status}: ${message.slice(0, 1024)}`;
}

function optionalResponseHeaders(response: Response): {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly link?: string;
  readonly serverDate?: string;
  readonly xPollIntervalSeconds?: number;
} {
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  const link = response.headers.get("link") ?? undefined;
  const serverDate = response.headers.get("date") ?? undefined;
  const xPollIntervalSeconds = parseOptionalInteger(response.headers.get("x-poll-interval"));
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
    ...(link === undefined ? {} : { link }),
    ...(serverDate === undefined ? {} : { serverDate }),
    ...(xPollIntervalSeconds === undefined ? {} : { xPollIntervalSeconds }),
  };
}

export class GitHubRestClient {
  readonly #config: Required<Pick<GitHubRestClientConfig, "maximumResponseBytes" | "requestTimeoutMs">> & GitHubRestClientConfig;
  readonly #apiBase: URL;
  readonly #governor: RateBudgetGovernor;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #state: StateStore;
  readonly #fetch: FetchLike;
  #tail: Promise<void> = Promise.resolve();
  #consecutiveSecondaryFailures = 0;

  constructor(
    config: GitHubRestClientConfig,
    governor: RateBudgetGovernor,
    clock: Clock,
    logger: Logger,
    state: StateStore,
    fetchImpl: FetchLike = fetch,
  ) {
    this.#config = {
      ...config,
      maximumResponseBytes: config.maximumResponseBytes ?? 10 * 1024 * 1024,
      requestTimeoutMs: config.requestTimeoutMs ?? 120_000,
    };
    this.#apiBase = new URL(config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`);
    this.#governor = governor;
    this.#clock = clock;
    this.#logger = logger;
    this.#state = state;
    this.#fetch = fetchImpl;
  }

  request<T>(
    method: "GET" | "POST" | "PATCH",
    pathOrUrl: string,
    priority: RequestPriority,
    options: {
      readonly conditional?: ConditionalHeaders;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly purpose: string;
    },
  ): Promise<GitHubResponse<T>> {
    return this.#enqueue(() => this.#requestNow<T>(method, pathOrUrl, priority, options));
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #resolveUrl(pathOrUrl: string): URL {
    const url = /^https?:\/\//u.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl.replace(/^\/+/, ""), this.#apiBase);
    if (url.origin !== this.#apiBase.origin || !url.pathname.startsWith(this.#apiBase.pathname)) {
      throw new Error("GitHub request URL escaped the configured API base");
    }
    return url;
  }

  async #requestNow<T>(
    method: "GET" | "POST" | "PATCH",
    pathOrUrl: string,
    priority: RequestPriority,
    options: {
      readonly conditional?: ConditionalHeaders;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
      readonly purpose: string;
    },
  ): Promise<GitHubResponse<T>> {
    const nowMs = this.#clock.now().getTime();
    const mode = this.#governor.mode(nowMs);
    if (!this.#governor.canRequest(priority, nowMs)) {
      throw new GitHubBudgetUnavailableError(priority, mode);
    }
    if (method !== "GET") {
      await this.#clock.sleep(this.#governor.mutationDelayMs(this.#clock.now().getTime()), options.signal);
      this.#governor.noteMutation(this.#clock.now().getTime());
    }

    const url = this.#resolveUrl(pathOrUrl);
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.#config.token}`,
      "User-Agent": this.#config.userAgent,
      "X-GitHub-Api-Version": this.#config.apiVersion,
    });
    if (options.conditional?.etag !== undefined) headers.set("If-None-Match", options.conditional.etag);
    if (options.conditional?.lastModified !== undefined) headers.set("If-Modified-Since", options.conditional.lastModified);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("GitHub request timed out")), this.#config.requestTimeoutMs);
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    const selected = selectHeaders(response.headers);
    const snapshot = this.#governor.observe(selected, this.#clock.now().getTime());
    if (snapshot !== undefined) this.#state.recordRateSnapshot(snapshot);

    const contentLength = parseOptionalInteger(response.headers.get("content-length"));
    if (contentLength !== undefined && contentLength > this.#config.maximumResponseBytes) {
      throw new GitHubApiError(response.status, "GitHub response exceeds configured byte limit");
    }
    const text = response.status === 304 || response.status === 204 ? "" : await response.text();
    if (Buffer.byteLength(text, "utf8") > this.#config.maximumResponseBytes) {
      throw new GitHubApiError(response.status, "GitHub response exceeds configured byte limit");
    }

    const lowerText = text.toLowerCase();
    const rateLimited = response.status === 429 || (
      response.status === 403 && (
        selected["retry-after"] !== undefined ||
        selected["x-ratelimit-remaining"] === "0" ||
        lowerText.includes("secondary rate limit") ||
        lowerText.includes("rate limit exceeded")
      )
    );
    if (rateLimited) {
      const retryAt = this.#governor.rateLimitRetryAtMs(
        response.status,
        selected,
        this.#clock.now().getTime(),
        this.#consecutiveSecondaryFailures,
      ) ?? this.#clock.now().getTime() + 60_000;
      this.#consecutiveSecondaryFailures += 1;
      this.#governor.blockUntil(retryAt);
      throw new GitHubRateLimitedError(retryAt, boundedApiMessage(response.status, text));
    }
    this.#consecutiveSecondaryFailures = 0;

    this.#logger.debug("github request", {
      method,
      purpose: options.purpose,
      status: response.status,
      rateMode: this.#governor.mode(this.#clock.now().getTime()),
      remaining: snapshot?.remaining,
      resource: snapshot?.resource,
    });

    const responseHeaders = optionalResponseHeaders(response);
    if (response.status === 304) {
      return { status: 304, notModified: true, ...responseHeaders };
    }
    if (!response.ok) throw new GitHubApiError(response.status, boundedApiMessage(response.status, text));

    const data = text === "" ? undefined : JSON.parse(text) as T;
    return {
      status: response.status,
      notModified: false,
      ...(data === undefined ? {} : { data }),
      ...responseHeaders,
    };
  }
}
