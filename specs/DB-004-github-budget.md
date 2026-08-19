# DB-004 — GitHub API, Plan Capability, and Cost Budget Policy

Status: active

Reference date: 2026-08-17

Primary sources:

- GitHub REST best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- REST API versions: https://docs.github.com/en/rest/about-the-rest-api/api-versions
- GitHub plans: https://docs.github.com/en/get-started/learning-about-github/githubs-plans
- Included product usage: https://docs.github.com/en/billing/reference/product-usage-included
- Protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches
- Rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- Registering a GitHub App: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app

## Principles

DevBridge treats GitHub API capacity and paid/metered GitHub usage as shared operator resources, not as private allowances owned by the daemon.

The reference deployment is a GitHub Free personal account. Richer GitHub plans may add useful features, but the core DevBridge safety and execution model must not require them.

## Free-first compatibility invariant

DevBridge must support its core workflow on the feature set available to a GitHub Free personal account, including repositories whose visibility/plan combination does not provide protected branches or rulesets.

Therefore:

- GitHub-side branch protection, rulesets, required reviewers, and equivalent server-side controls are defense in depth when available, not the sole enforcement mechanism for publication safety.
- Local checkpoint, decision, credential, repository-identity, and publication policy must remain sufficient when those GitHub features are unavailable.
- GitHub Actions, Codespaces, Packages, hosted build infrastructure, or paid storage are not required for normal local validation.
- A plan-restricted endpoint or feature is treated as an unavailable optional capability, not automatically as a transient error to retry repeatedly.
- Prefer observing concrete repository/account capabilities to coupling core logic to a marketing plan name.
- Capability observations should be cached/persisted with an expiry or invalidation strategy so feature detection itself does not waste API budget.

As of the reference date, GitHub documents protected branches and rulesets as available for public repositories on GitHub Free but not private repositories on a Free personal account. Paid personal/team/enterprise plans expose additional private-repository controls. These are reference facts, not permanent architectural assumptions.

## API requirements

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
15. Adaptive polling/backoff should consider both remaining budget and time until reset; a raw `remaining < N` threshold alone is insufficient for future scheduling decisions.

## Authentication modes

DevBridge should support at least:

- a narrowly scoped personal/fine-grained token mode for the simplest local setup;
- GitHub App installation authentication as an optional free-compatible mode.

A GitHub App is not assumed to require a paid GitHub account. GitHub currently permits registering an app under a personal account and installing it on selected repositories.

Installation access-token traffic has an installation rate pool separate from ordinary user/PAT traffic. User access tokens issued through an app still share the authenticated user's rate budget and must not be mistaken for installation isolation.

Credential mode is locally configured. Remote tasks cannot choose or widen it.

Where practical, polling/status authority and source-publication authority should be separable so a frequently used credential does not automatically carry unnecessary push/promotion authority.

## Cost policy

GitHub plan cost and GitHub API rate budget are separate concerns.

The default product posture is **free-first / no intentional paid usage**:

- DevBridge does not deliberately select a paid GitHub-hosted runner, paid Codespaces capacity, paid package/storage tier, or other chargeable GitHub service merely because billing is enabled.
- Local compilation, testing, browser automation, and model execution are the normal execution path.
- Optional paid integrations require explicit local operator policy and must be represented as capabilities rather than silently activated fallbacks.
- Exhaustion of a free allowance must degrade or stop the optional feature; it must not silently convert into spend authorized by a remote task or model.

DevBridge cannot assume an account's external billing budget is configured to prevent overage. Where GitHub supports operator-side budgets such as "stop usage when budget limit is reached," documentation may recommend them as an additional billing safeguard, but they are not a substitute for DevBridge's own free-first behavior.

## Indirect metered effects

A Git push or pull request update may trigger GitHub Actions workflows even when DevBridge never invokes the Actions API directly. Publication can therefore have a metered side effect on private repositories.

Publication/checkpoint evidence should indicate known potential workflow triggers when reasonably determinable from the trusted baseline/candidate repository configuration. DevBridge must not claim it can perfectly predict all server-side automation.

In free-first mode:

- local tests remain authoritative evidence generated by DevBridge's local validator;
- GitHub-hosted Actions are optional corroborating evidence, not required infrastructure;
- DevBridge must not intentionally re-run workflows merely to duplicate local tests unless local policy permits that quota use;
- repeated pushes solely to obtain GitHub-hosted CI feedback should be avoided when equivalent local validation is available.

As of the reference date, GitHub Free includes 2,000 GitHub-hosted Actions minutes per month and 500 MB Actions artifact storage for private-repository use, while standard GitHub-hosted runners in public repositories are documented as free. These amounts may change and must not become hard-coded architectural limits.

## Current API version

The adapter pins `X-GitHub-Api-Version: 2026-03-10`, the current supported version as of the reference date. Version changes require a deliberate compatibility review and tests.

## Poll cadence

Default idle polling is 60 seconds, subject to GitHub's `X-Poll-Interval` and local backoff. Conditional `304` responses preserve the primary budget when GitHub's documented conditions are met, but they still represent traffic, so faster polling requires an explicit operator reason.

## Status traffic

Use one durable status comment per run where practical and update it rather than creating a stream of progress comments. Progress updates are time-coalesced and stage-aware. Terminal handoffs are always attempted when budget policy permits.

A pending human checkpoint does not justify a high-frequency comment poll. Human-attention polling follows DB-006 and DB-007 while still obeying this API budget.

## Required future tests

Plan/cost-aware implementation must prove at minimum:

- the core coordinator does not require private-repository branch protection/rulesets;
- absence of an optional paid/plan feature degrades safely rather than entering an unbounded retry loop;
- optional feature discovery is cached/bounded;
- PAT/user-budget and GitHub App installation-budget modes are accounted independently where configured;
- free-first mode never deliberately selects a metered GitHub execution/storage capability without local authorization;
- local validation can complete without GitHub Actions;
- publication evidence can flag known possible Actions-triggering pushes without claiming perfect prediction.
