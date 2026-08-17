# Prior Art and GitHub API Constraints — 2026-08-17

## Purpose

Record the external evidence that shaped the initial architecture. This document is research evidence; active specs remain authoritative.

## Closest prior art

### Ove

- Repository: https://github.com/jacksoncage/ove
- Local agent daemon with GitHub comment polling, queues, worktrees, and Codex/Claude runners.
- Useful reference for adapters and worker separation.
- Not adopted because its GitHub adapter uses a short polling window and in-memory seen IDs, invokes `gh`, runs on Bun, and lacks PATCH-POLLER's exact head/path/capability/context guards.

### Looper

- Repository: https://github.com/nexu-io/looper
- Useful reference for multi-repository registration, worktrees, leases, and restart recovery.
- Not adopted because it is a broader autonomous loop and not a Windows-first Node.js bounded-capability mailbox.

### GitHub self-hosted runners and agentic workflows

- Useful references for outbound job polling, leases, logs, cancellation, and permission separation.
- Not adopted as the controlling execution pathway because they move work into GitHub Actions/model pathways rather than keeping ChatGPT Classic as controller and the local daemon as bounded hands.

## Official GitHub guidance

Primary sources:

- REST best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- API versions: https://docs.github.com/en/rest/about-the-rest-api/api-versions
- Issue-comment endpoints: https://docs.github.com/en/rest/issues/comments
- GitHub App authentication: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app

Load-bearing findings:

1. GitHub recommends webhooks over polling, but when polling is required it recommends fixed/adaptive schedules, `x-poll-interval` compliance, authenticated conditional requests, and cache-stable narrow requests.
2. Correctly authenticated `304 Not Modified` conditional responses do not consume the primary rate limit.
3. Requests should be serialized to avoid secondary limits.
4. Mutative requests should be spaced by at least one second.
5. `retry-after` must be obeyed; when primary remaining reaches zero, wait until `x-ratelimit-reset`; suspected secondary limits otherwise require at least a one-minute and then exponential backoff.
6. Continuing to request while limited can result in integration bans.
7. Authenticated user/PAT traffic commonly shares a 5,000-request-per-hour user budget. GitHub App installation tokens use an installation budget and are preferred when practical.
8. Secondary limits are shared across REST and GraphQL and include concurrency, point, and CPU-time constraints.
9. REST API versions must be explicitly pinned. As of this research, `2026-03-10` and `2022-11-28` are supported on GitHub.com; version selection remains configuration with a tested default.

## Node.js durability choice

Primary source: https://nodejs.org/api/sqlite.html

`node:sqlite` is available without an experimental flag and is release-candidate stability in the supported Node 24/26 range. PATCH-POLLER uses it behind a state-store port so it can be replaced without changing domain/application code.

## Architectural implications

- One serialized request queue per credential identity.
- Persist ETags and endpoint cursors.
- One lifecycle report comment per dispatch.
- Coalesce status changes and reserve budget for terminal reports.
- Prefer a GitHub App installation token, while retaining a token-provider port for local deployment flexibility.
- Do not query `/rate_limit` as a heartbeat; observe headers on ordinary requests.
- Do not use GraphQL merely to reduce endpoint count; evaluate total cost and cacheability first.
