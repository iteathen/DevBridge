# Implementation Roadmap

Work is organized by ownership boundary so the project stays reviewable and agents do not create half-connected features across the system.

## v0.1 operational checkpoint — implemented on main

The first usable local bridge now exists:

- trusted GitHub task/feedback protocols and rate-conscious REST client;
- managed Git clone/fetch/origin validation;
- isolated per-run task worktrees/branches with immutable baseline SHA;
- controlled Git home/config/hooks/credential-helper/protocol behavior;
- shell-free bounded coding-tool execution with context/result bridge;
- durable multi-turn run state and trusted feedback resume;
- candidate Git validation plus PATCH-POLLER-owned sealing commit;
- optional dedicated task-branch publication, disabled by default;
- stage-aware restart finalization/publication recovery;
- same-issue active-revision deferral;
- `run-once` and single-instance `daemon` loop;
- local end-to-end acceptance fixture;
- verified Linux Bubblewrap containment for deterministic operations that execute repository code, with fail-closed behavior on unsupported hosts;
- cross-platform CI covering the normal suite plus mandatory Linux sandbox boundary verification.

This checkpoint is intentionally **not** called production-hardened. Critical issue #22's repository-code sandbox stop-ship is resolved for supported Linux hosts. PP-007 through PP-010 still define remaining decision, supply-chain, recovery, and provenance work, and non-Linux repository-code sandbox providers remain explicit platform work.

## Slice 0 — Foundation — complete

Completion gates satisfied:

- architecture/spec foundation;
- task/feedback protocols reject remote machine authority;
- persistent conditional GitHub polling and budget primitives;
- path containment and redaction tests;
- generic shell-free CLI runner;
- context/status primitives;
- checkpoint-and-proceed doctrine specified.

## Slice 1 — Managed Git workspace — v0.1 core complete, hardening remains

Implemented:

- controlled local Git adapter;
- clone missing allowed repositories below managed root;
- exact origin verification before reuse;
- per-run branch/worktree;
- immutable persisted base SHA;
- candidate validation/sealing;
- dedicated task-branch push path;
- runtime path exclusion/reserved-path rejection;
- conservative lock/recovery doctrine.

Remaining:

- numeric GitHub repository-ID pinning/rename-transfer reconciliation (PP-010);
- formal retention/disposal sweeper;
- stronger per-repository lease when concurrency exceeds one worker;
- submodule/LFS/package-manager phase capabilities (PP-008).

## Slice 2 — Durable coordinator — v0.1 core complete, PP-007 policy remains

Implemented:

- one authoritative `RunCoordinator`;
- durable run/task revision identity;
- duplicate terminal-run suppression;
- active older-revision deferral;
- context capsule every turn;
- `complete`/`continue`/`blocked`/`failed` result protocol;
- clean-exit compatibility for legacy CLIs;
- max-turn/timeout/cancel behavior;
- immutable-baseline resume;
- stage-aware verifying/publishing recovery.

Remaining:

- full PP-007 orthogonal checkpoint/decision state machine;
- safe-frontier calculation and checkpoint-and-proceed execution;
- architectural-change signals/thresholds;
- `artifact-exact`/`decision-scope` approval binding;
- interrupted-invocation reconciliation stronger than a conservative additional turn.

## Slice 3 — Progress, feedback, decisions, handoff — basic v0.1 loop implemented

Implemented:

- coalesced status comment primitive;
- bounded/redacted context/status;
- trusted run/revision-bound continuation/cancel feedback;
- terminal status attempts;
- context continuity across turns.

Remaining:

- PP-007 `decision-v1` protocol/delegation;
- checkpoint deduplication/attention budget;
- continuing/waiting/hard-gate status vocabulary;
- generic remote-effect journal for crash windows (PP-009);
- complete provenance/replay consumption records (PP-010);
- optional label mirroring.

## Slice 4 — Sandbox/tool profiles — Linux repository-code boundary complete, other platform/phase work remains

Implemented:

- local tool profiles;
- shell-free argv execution;
- allowlisted environment inheritance;
- timeout/output limits;
- whole-process-tree termination attempt (POSIX process group; Windows `taskkill /T` fallback);
- deterministic operation classification into static inspection and repository-code execution;
- fail-closed refusal of repository-code operations without a verified provider;
- verified Linux Bubblewrap provider using mount/user/PID/network namespaces;
- project and current run-scratch as the only ordinary writable roots for repository-code deterministic operations;
- arbitrary external reads denied by default, with locally configured `workspace.externalReadRoots` and required tool roots exposed read-only;
- ordinary deterministic build/test network egress denied;
- PATCH-POLLER state, operator home/credential state, and unrelated host paths left unreachable;
- `.git` administrative state read-only or unreachable;
- adversarial provider admission probe covering external read/write, control-state read, network egress, `.git` mutation, project/scratch writes, and effective child capabilities;
- `doctor` reporting observed provider availability, verification result, and per-operation usability;
- tool-declared sandbox properties and Codex profile guidance.

Remaining:

- verified Windows OS containment provider (Job Object/AppContainer or equivalent);
- verified providers for other supported non-Linux hosts if added;
- explicit dependency-fetch/install/browser phases with narrowly granted network authority (PP-008), rather than weakening ordinary build/test denial;
- browser/Playwright profile with contained loopback where justified;
- CPU/memory/disk/process-count quotas;
- version/capability probing and profile digests.

## Slice 5 — Daemon and effect hardening — first loop implemented

Implemented:

- polling loop honoring base interval/rate errors;
- single local daemon lock;
- resume non-terminal state before new work;
- bounded error backoff.

Remaining:

- generic PP-009 operation journal/reconciliation;
- stale-lock diagnosis/explicit recovery tooling;
- bounded log/run/worktree retention sweeper;
- Windows service packaging;
- health/status command with no unnecessary GitHub traffic;
- optional webhook `TaskSource` if deployment value justifies it.

## Slice 6 — Supply-chain and independent verification

Required work from PP-008:

- explicit dependency fetch/install/build/test/browser/publication phases;
- package-manager lifecycle-script policy;
- trust-scoped caches;
- locked/reproducible install modes where available;
- independent verifier profiles/commands owned by local policy rather than model claims;
- evidence classification distinguishing model-reported tests from PATCH-POLLER-observed verifier results.

## Deferred until justified

- multiple concurrent workers for one queue;
- distributed leases;
- GraphQL optimization;
- database server dependency;
- plugin marketplace/dynamic remote plugins;
- arbitrary shell task format.

These are not prohibited forever. They require evidence that the simpler boundary no longer meets the real workload.