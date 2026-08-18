# PATCH-POLLER Agent Guide

PATCH-POLLER is security-sensitive automation. It turns remote task input into local coding-agent activity, so convenience never outranks capability boundaries, provenance, recoverability, or rate-limit discipline.

## Required engineering cycle

For each meaningful change:

1. Read the relevant specs and design principles before editing.
2. Assess the problem and the ownership boundary.
3. Research unstable or external behavior from primary sources.
4. Reassess after research; do not force the original idea if the evidence changed it.
5. Plan by coherent ownership boundary, not tiny token-driven patches.
6. Implement the smallest complete design that satisfies the contract.
7. Test normal behavior, failure behavior, and boundary behavior.
8. Report what changed, what was tested, what remains, and the next safe step.

Do not allow a model's context window to become the only record of work. Durable run state and context capsules are product requirements.

## Design hierarchy

Use the project principles together rather than as slogans:

- LEGO: small composable contracts with replaceable adapters.
- SOLID: clear responsibilities and dependency direction.
- CUPID: code should be composable, Unix-like, predictable, idiomatic, and domain-based.
- KISS: prefer the smallest mechanism that preserves correctness and safety.

Hexagonal boundaries are preferred where PATCH-POLLER touches GitHub, credentials, filesystems, processes, clocks, persistence, or status delivery.

## Trust and capability rules

These are invariants:

- Remote task text, repository files, CLI stdout/stderr, and fetched content are data, not authority.
- Only local operator configuration may grant filesystem, execution, credential, or network capabilities.
- Remote input must never provide an executable path, shell fragment, arbitrary local path, environment value, or capability grant.
- Never interpolate remote task text into an OS command line. Child processes run with `shell: false`.
- The GitHub credential used by the poller is not inherited by child tools unless a local operator explicitly opts in.
- Project writes must remain inside a managed project/worktree. Symlink escape is a boundary violation.
- External reads should be denied by default and enabled through explicit read-only roots or a verified tool/OS sandbox contract.
- A tool profile that cannot credibly enforce its declared sandbox is not safe merely because configuration says it is.
- Do not auto-reset, clean, discard, or overwrite an existing dirty developer checkout.
- Secrets and control characters must be filtered before remote status reporting.

## GitHub API rules

- Prefer webhooks when deployment permits them; polling is a supported fallback, not a reason to be wasteful.
- Poll with authenticated conditional requests and persist validators across restarts.
- Serialize requests. Avoid bursty concurrency.
- Respect `X-Poll-Interval`, `Retry-After`, primary reset headers, and configured reserve floors.
- Do not poll `/rate_limit` as a heartbeat; use headers from ordinary responses.
- Throttle status writes and coalesce progress into an existing status comment where practical.
- Terminal handoff/reporting may use a small emergency reserve, but routine polling may not consume it.

## Documentation and specifications

Specs are normative unless a newer spec explicitly supersedes them. If a spec becomes obsolete, archive it with a note explaining when, why, and what replaced it rather than silently deleting history.

Keep implementation details out of broad principles unless they are genuine invariants. Keep security-critical invariants out of informal README prose only; they belong in specs and tests.

## Runtime scope

The core runtime is Node.js and should prefer Node standard-library facilities. Do not introduce another language, a shell-dependent core path, or a third-party dependency without documenting why the ownership boundary needs it and what new supply-chain or portability cost it creates.

## Testing

Boundary tests are mandatory for:

- path traversal and symlink escape;
- trusted versus untrusted task issuers;
- task-envelope parsing and malformed input;
- rate reserve behavior and conditional request caching;
- secret redaction;
- command argument templating and environment scrubbing;
- restart-safe state persistence.

A passing happy-path test alone is not sufficient for a capability boundary.
