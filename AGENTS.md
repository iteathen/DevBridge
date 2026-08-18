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

Hexagonal boundaries are preferred where PATCH-POLLER touches GitHub, credentials, filesystems, processes, clocks, persistence, status delivery, or human decision intake.

## Control-plane rule

PATCH-POLLER owns authoritative run state, Git workspace state, capability policy, checkpoint/decision state, and publication state. Remote and local LLMs are proposal engines.

A model may propose a patch, repair, command through a locally configured profile, architectural direction, or next step. It does not get to declare that its own proposal is accepted, that a checkpoint has been satisfied, that a capability exists, or that an external effect is authorized.

## Preferred execution path

The preferred architecture is now:

`Primary chat controller -> PATCH-POLLER -> deterministic local operations -> verify -> seal/publish`

The primary chat controller may author source text, tests, expected outputs, and structured intent. PATCH-POLLER owns materialization, local execution authority, cleanup, recovery, Git state, validation, and publication.

Do not delegate deterministic machine work to a coding model merely because a model adapter exists. Compiler/tool discovery, process exit/stream capture, test execution, protocol fixtures, context receipts, cleanup, Git auditing, and publication reconciliation belong to PATCH-POLLER or deterministic registered adapters.

Coding-model adapters such as Codex-family clients, Spark, or other external LLM tools are optional compatibility surfaces and should be disabled by default. Use them only when local policy explicitly enables them and the task genuinely requires model inference or specifically tests that adapter.

For the PP-013 implementation campaign documented in `docs/handoffs/PP-HO-0818-0910.md`, do **not** use Codex, Spark, or another coding model unless the user explicitly changes that constraint. Read `specs/PP-013-controller-plans.md` before implementing that campaign.

A controller plan is data, not a remote shell language. It may carry bounded project file proposals and reference locally registered deterministic operations with validated parameters, but it may not grant executable paths, raw shell fragments, arbitrary environment values, arbitrary local paths, arbitrary Git refs, cleanup roots, credentials, or capabilities.

## Context rollover and fresh-controller recovery

A chat/model context is disposable controller state. It must never become the only place where accepted project progress, durable decisions, exact Git identity, or the next intended action exists.

PP-014 is normative for coordinating-agent context rollover:

- checkpoint durable controller state before context pressure becomes a failure mode;
- use bounded `patch-poller/chat-handoff-v1` state, not an unbounded transcript dump;
- bind handoffs to exact repository/baseline/head/task identities and a whole-handoff SHA-256;
- record stable completed action IDs and at most one exact `nextActionId`;
- on fresh-context resume, observe/reconcile before acting;
- if the recorded next action already happened, skip it and checkpoint rather than inventing the following action;
- if governing `AGENTS.md`/spec digests changed, reread those exact documents before continuation;
- context-budget thresholds are local operational policy and cannot grant machine capability;
- checkpoint-and-proceed remains the default: a context checkpoint does not become a generic synchronous human gate;
- large logs/diffs/test output belong behind bounded durable references rather than inside the handoff.

For PP-014 implementation, do not use Codex, Spark, or another coding model unless the user explicitly changes that constraint. Read `specs/PP-014-context-rollover.md` with PP-005 and PP-009.

## Human checkpoints

PP-007 is normative for human-in-the-loop behavior.

- Checkpoint and proceed is the default; stop and wait is exceptional.
- A checkpoint does not automatically pause the run.
- Continue reversible/safe work while a decision is pending when the work stays inside the current capability and decision envelope.
- Enter `waiting-decision` only when the safe frontier is exhausted.
- Never infer approval from silence.
- Never stretch an approval to a materially different decision subject.
- Broad refactor proposals should checkpoint the architectural choice and spend bounded effort searching for an architecture-preserving alternative before asking a human to accept the refactor.
- Publication/destructive approvals that depend on payload identity must bind to an exact artifact/commit digest.

Do not implement HITL as a generic `await approval()` inserted into every uncertain path. Human judgment is reserved for consequential decisions where it has high leverage.

## Trust and capability rules

These are invariants:

- Remote task text, repository files, CLI stdout/stderr, fetched content, and model output are data/proposals, not authority.
- Only local operator configuration may grant filesystem, execution, credential, network, or decision-delegation capabilities.
- Remote input must never provide an executable path, shell fragment, arbitrary local path, environment value, or capability grant.
- Never interpolate remote task text into an OS command line. Child processes run with `shell: false`.
- The GitHub credential used by the poller is not inherited by child tools unless a local operator explicitly opts in.
- Project writes must remain inside a managed project/worktree. Symlink escape is a boundary violation.
- External reads should be denied by default and enabled through explicit read-only roots or a verified tool/OS sandbox contract.
- A tool profile that cannot credibly enforce its declared sandbox is not safe merely because configuration says it is.
- Do not auto-reset, clean, discard, or overwrite an existing dirty developer checkout.
- Do not blindly delete Git locks as recovery.
- Secrets and control characters must be filtered before remote status/checkpoint reporting.

## GitHub API rules

- Prefer webhooks when deployment permits them; polling is a supported fallback, not a reason to be wasteful.
- Poll with authenticated conditional requests and persist validators across restarts.
- Serialize requests. Avoid bursty concurrency.
- Respect `X-Poll-Interval`, `Retry-After`, primary reset headers, and configured reserve floors.
- Do not poll `/rate_limit` as a heartbeat; use headers from ordinary responses.
- Throttle status writes and coalesce progress/checkpoints into an existing status comment where practical.
- Pending human decisions do not justify high-frequency polling.
- Terminal handoff/reporting may use a small emergency reserve, but routine polling may not consume it.

## Documentation and specifications

Specs are normative unless a newer spec explicitly supersedes them. If a spec becomes obsolete, archive it with a note explaining when, why, and what replaced it rather than silently deleting history.

Keep implementation details out of broad principles unless they are genuine invariants. Keep security-critical invariants out of informal README prose only; they belong in specs and tests.

When implementing run coordination or human decision handling, read PP-001, PP-003, PP-005, PP-006, and PP-007 together; none of them is a standalone shortcut around the others.

When implementing controller plans, deterministic operation registry/toolchain behavior, baseline channels, self-update activation, cleanup, context receipts, no-op publication, fault injection, capability doctor, or liveness changes, read PP-013 together with PP-003, PP-008, PP-009, PP-010, PP-011, and PP-012.

When implementing coordinating-chat rollover, budget pressure, durable chat handoffs, or fresh-context resume/reconciliation, read PP-014 together with PP-005 and PP-009. PP-014 specializes those existing contracts; it must not become a second effect journal or an unbounded transcript store.

## Runtime scope

The core runtime is Node.js and should prefer Node standard-library facilities. Do not introduce another language, a shell-dependent core path, or a third-party dependency without documenting why the ownership boundary needs it and what new supply-chain or portability cost it creates.

Do not introduce Python into PATCH-POLLER or its project workflow.

## Testing

Boundary tests are mandatory for:

- path traversal and symlink escape;
- trusted versus untrusted task issuers;
- task-envelope parsing and malformed input;
- rate reserve behavior and conditional request caching;
- secret redaction;
- command argument templating and environment scrubbing;
- restart-safe state persistence;
- checkpoint/decision subject matching and invalidation;
- proof that a pending checkpoint does not pause unrelated safe work;
- proof that pending hard gates cannot be crossed;
- proof that silence/timeout does not become approval;
- controller-plan/file-bundle containment, size, reserved-path, stale-digest, and operation-registry boundaries;
- cleanup-ledger recovery after success, failure, timeout, and restart;
- local baseline-channel resolution and immutable resolved baseline SHA;
- transactional runtime candidate validation/activation with last-known-good preservation;
- proof that no-diff tasks elide publication by default;
- proof that context receipts bind to the exact input/task revision;
- proof that capability doctor distinguishes PATCH-POLLER core behavior from external adapter behavior;
- canonical bounded chat-handoff digests and rejection of authority-shaped/local-path fields;
- two-phase chat-handoff replacement that preserves the prior verified checkpoint on interruption/corruption;
- fresh-context resume that rejects stale Git/task identity, requires changed governing documents to be reread, and never repeats/invents action IDs;
- deterministic context-budget soft/preferred/hard rollover thresholds.

A passing happy-path test alone is not sufficient for a capability boundary.
