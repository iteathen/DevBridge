# Implementation Roadmap

Work is organized by ownership boundary so the project stays reviewable and agents do not create half-connected features across the system.

## Slice 0 — Foundation — complete in bootstrap branch

Completion gates:

- architectural/spec foundation exists;
- task and feedback protocols reject remote machine authority;
- GitHub conditional polling and budget primitives are persistent/tested;
- path containment and redaction are tested;
- generic shell-free CLI runner exists;
- context/status primitives exist;
- tests pass without third-party runtime dependencies.

The human checkpoint/decision doctrine is specified in PP-007 during the foundation PR, but its runtime coordinator behavior belongs to Slices 2 and 3.

## Slice 1 — Managed Git workspace provisioning

Owns repository acquisition and isolation, not model orchestration.

Required work:

- local Git executable adapter with environment allowlist;
- clone missing allowed repositories below the managed root;
- verify existing repository identity/remote before reuse;
- create one task branch/worktree per run;
- refuse dirty unmanaged checkouts rather than cleaning them;
- persist branch, worktree path, base SHA, and task revision;
- bounded fetch behavior and explicit credential strategy;
- serialize Git operations per repository;
- recovery/cleanup that deletes only poller-owned paths after containment/ownership verification;
- preserve failed/waiting worktrees until evidence/lease policy says they are disposable rather than deleting them unconditionally in `finally()`;
- recover uncertain Git administrative state conservatively; do not blindly delete lock files.

Completion gate: a test fixture can provision, resume, retain-for-recovery, and safely dispose a local repository/worktree without network access or path escape.

## Slice 2 — Durable run coordinator and checkpoint policy

Owns lifecycle/state transitions and safe-progress decisions.

Required work:

- durable run ID and task-revision idempotency;
- one authoritative `RunCoordinator`; event listeners may observe but do not independently advance authoritative state;
- local single-worker lock;
- explicit lifecycle transition validation;
- choose only locally configured/allowed tool profiles;
- feed a complete context capsule on every tool turn;
- merge structured result data without discarding prior context when result parsing fails;
- max-turn, timeout, and cancellation gates;
- no automatic destructive recovery of agent changes;
- treat remote and local LLMs as proposal engines whose candidate work is validated before becoming authoritative;
- persist PP-007 checkpoint records independently of model memory;
- represent human-attention state orthogonally to the primary lifecycle;
- compute a safe/reversible work frontier when a checkpoint or decision is pending;
- continue useful work within that frontier rather than automatically entering a blocking state;
- enter `waiting-decision` only when the safe frontier is exhausted;
- implement inspectable architectural-change signals and configurable churn/ownership thresholds;
- when a broad refactor checkpoint fires, spend bounded effort searching for an architecture-preserving solution and record failed alternatives as evidence;
- implement `artifact-exact` and `decision-scope` subject binding/invalidation semantics.

Completion gate: a fake coding CLI can complete, continue, checkpoint and keep working safely, exhaust its safe frontier and wait, resume after process restart, fail, and cancel with deterministic persisted state. Tests prove a pending decision boundary cannot be crossed and an unrelated safe action does not pause merely because a checkpoint exists.

## Slice 3 — Progress, feedback, decisions, and handoff loop

Owns remote coordination traffic.

Required work:

- claim/start status;
- time-coalesced progress using one status comment;
- bounded output-tail/status integration;
- ordinary feedback polling only while a request is outstanding;
- PP-007 `patch-poller/decision-v1` parsing with actor/run/task/checkpoint/subject matching;
- distinguish ordinary continuation authority from delegated decision-class authority;
- publish checkpoint summaries that state whether safe work is continuing or exhausted;
- statuses equivalent to `CHECKPOINTED_CONTINUING`, `DECISION_PENDING_CONTINUING`, `WAITING_DECISION`, and `HARD_GATE_PENDING`;
- checkpoint fingerprinting/deduplication and attention-budget behavior so equivalent questions do not spam humans;
- labels may mirror state but are not authority unless a later spec defines trusted label provenance;
- terminal handoff with context chunking only when one comment cannot fit;
- terminal status attempts may use emergency API reserve;
- provenance/redaction tests for every outbound path;
- context rehydration must preserve pending/accepted/rejected checkpoints and exact decision-subject identity.

Completion gate: a coordinating agent or human can reconstruct the run and its pending decision surfaces from GitHub alone after losing conversation context; a trusted decision can resume the exact bound subject, while stale/mismatched decisions are rejected and silence never becomes approval.

## Slice 4 — Sandbox adapters and tool profiles

Owns actual containment claims for supported CLIs/platforms.

Required work:

- document and test at least one Windows-safe coding CLI profile;
- distinguish tool-enforced versus OS-enforced isolation;
- explicit read-only external roots;
- network policy declaration/enforcement where supported;
- phase-aware network policy for provisioning, build/test, loopback browser testing, and publication where practical;
- browser/Playwright-capable profile separated from ordinary coding profile;
- process-tree termination/resource containment assessment;
- platform containment adapter rather than pretending Unix process-group behavior is portable to Windows;
- never mark an enforcement property true because it is merely desired.

Completion gate: sandbox claims in local configuration correspond to tested behavior on the target platform, including timeout/process-tree behavior.

## Slice 5 — Daemon hardening

Required work:

- adaptive/fixed polling loop honoring GitHub minimum interval and local reserve/backoff;
- startup/shutdown recovery;
- bounded local logs and run/checkpoint retention;
- daemon/service packaging appropriate to Windows first, without coupling the core to service management;
- health/status command that does not waste GitHub API calls;
- lease/heartbeat ownership sufficient to prevent two local daemon instances from recovering the same run;
- optional webhook `TaskSource` research and adapter if deployment value justifies it.

## Deferred until justified

- multiple concurrent workers for one queue;
- distributed leases;
- GraphQL optimization;
- database server dependency;
- plugin marketplace/dynamic remote plugins;
- arbitrary shell task format.

These are not prohibited forever. They require evidence that the simpler boundary no longer meets the real workload.
