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
- recovery/cleanup that deletes only poller-owned paths after containment verification.

Completion gate: a test fixture can provision, resume, and safely dispose a local repository/worktree without network access or path escape.

## Slice 2 — Multi-turn run coordinator

Owns lifecycle/state transitions.

Required work:

- durable run ID and task-revision idempotency;
- local single-worker lock;
- explicit lifecycle transition validation;
- choose only locally configured/allowed tool profiles;
- feed a complete context capsule on every tool turn;
- merge structured result data without discarding prior context when result parsing fails;
- max-turn, timeout, and cancellation gates;
- no automatic destructive recovery of agent changes.

Completion gate: a fake coding CLI can complete, continue, block for feedback, resume after process restart, fail, and cancel with deterministic persisted state.

## Slice 3 — Progress, feedback, and handoff loop

Owns remote coordination traffic.

Required work:

- claim/start status;
- time-coalesced progress using one status comment;
- bounded output-tail/status integration;
- feedback polling only in waiting state;
- terminal handoff with context chunking only when one comment cannot fit;
- terminal status attempts may use emergency API reserve;
- provenance/redaction tests for every outbound path.

Completion gate: a coordinating agent can reconstruct the run from GitHub alone after losing its conversation context.

## Slice 4 — Sandbox adapters and tool profiles

Owns actual containment claims for supported CLIs/platforms.

Required work:

- document and test at least one Windows-safe coding CLI profile;
- distinguish tool-enforced versus OS-enforced isolation;
- explicit read-only external roots;
- network policy declaration/enforcement where supported;
- browser/Playwright-capable profile separated from ordinary coding profile;
- process-tree termination/resource containment assessment;
- never mark an enforcement property true because it is merely desired.

Completion gate: sandbox claims in local configuration correspond to tested behavior on the target platform.

## Slice 5 — Daemon hardening

Required work:

- adaptive/fixed polling loop honoring GitHub minimum interval and local reserve/backoff;
- startup/shutdown recovery;
- bounded local logs and run retention;
- daemon/service packaging appropriate to Windows first, without coupling the core to service management;
- health/status command that does not waste GitHub API calls;
- optional webhook `TaskSource` research and adapter if deployment value justifies it.

## Deferred until justified

- multiple concurrent workers for one queue;
- distributed leases;
- GraphQL optimization;
- database server dependency;
- plugin marketplace/dynamic remote plugins;
- arbitrary shell task format.

These are not prohibited forever. They require evidence that the simpler boundary no longer meets the real workload.
