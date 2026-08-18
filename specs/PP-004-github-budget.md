# PP-004 — GitHub API Budget Policy

Status: active

Reference date: 2026-08-17

Primary sources:

- GitHub REST best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- REST API versions: https://docs.github.com/en/rest/about-the-rest-api/api-versions

## Principles

PATCH-POLLER treats the GitHub API budget as shared infrastructure, not as a private allowance.

## Requirements

1. Authenticate normal polling.
2. Persist `ETag`/`Last-Modified` validators and make conditional requests.
3. Keep poll URLs stable and narrowly filtered so unchanged responses are likely to return `304`.
4. Serialize API requests; no speculative request fan-out.
5. Respect `X-Poll-Interval` when present.
6. Observe `X-RateLimit-Limit`, `Remaining`, `Used`, `Reset`, and `Resource` from ordinary responses.
7. Do not call `/rate_limit` as a routine heartbeat.
8. Maintain a configurable reserve floor. Routine polling stops before that reserve is consumed.
9. Maintain a smaller emergency reserve for terminal reporting/recovery only.
10. Space mutating requests by at least the configured mutation interval, defaulting above GitHub's one-second recommendation.
11. On `Retry-After`, do not retry before it expires.
12. When remaining is zero, do not retry before reset.
13. For secondary-limit responses without those headers, wait at least one minute, then use exponential backoff on repeated failures.
14. Stop retrying after a bounded attempt count.

## Current API version

The adapter pins `X-GitHub-Api-Version: 2026-03-10`, the current supported version as of the reference date. Version changes require a deliberate compatibility review and tests.

## Poll cadence

Default idle polling is 60 seconds, subject to GitHub's `X-Poll-Interval` and local backoff. Conditional `304` responses preserve the primary budget, but they still represent traffic, so faster polling requires an explicit operator reason.

## Status traffic

Use one durable status comment per run where practical and update it rather than creating a stream of progress comments. Progress updates are time-coalesced and stage-aware. Terminal handoffs are always attempted when budget policy permits.
