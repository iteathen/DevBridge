# Implementation Roadmap

This roadmap reflects the current `main` implementation after the security/capability campaign and issue #49 PRs through the PP-018 runtime-governance slice.

Work is organized by ownership boundary so the project stays reviewable and agents do not create half-connected features across the control plane.

## Current operational checkpoint

PATCH-POLLER now has a complete local control-plane path for trusted task intake, managed development work, verification, recovery, and bounded publication on verified Linux hosts.

Implemented current-state capabilities include:

- exact GitHub task/feedback/decision provenance with trusted numeric actor IDs and complete-current-content edit verification;
- managed repository/worktree provisioning and hardened Git control operations;
- durable multi-turn run state, restart recovery, and context capsules;
- PP-007 artifact-exact hard gates before sensitive sealing/publication;
- deterministic PP-013 controller plans and locally registered operations;
- exact final-byte verification after deterministic operations/cleanup;
- verified Linux Bubblewrap isolation for repository-code operations and proposal workers;
- control-owned worker IPC outside proposal worktrees;
- signed immutable production self-update release subjects with sandboxed candidate validation and last-known-good rollback;
- sanitized local tool inventory and bounded sandboxed dynamic operation onboarding;
- durable PP-014 chat-context rollover/resume;
- PP-016 Ed25519 installation identity, signed task leases, exact Git-ref CAS, heartbeat/TTL recovery, fencing, and coordination branch namespacing;
- PP-017 baseline drift reconciliation, fast-forward-only automated rebase, mandatory reverification, and exact verified-head publication CAS;
- PP-018 cooperative pause/resume and below-normal child-process QoS;
- effective serialized task admission (one task/run continuation at a time).

This is still pre-production software. The remaining work below is explicit rather than hidden behind optimistic status wording.

## Security deployment boundary — current

A runner's `github.trustedActorIds` is a remote development-job submission allowlist.

Current PP-016 coordination prevents conflicting compliant agents from owning the same task, but task envelopes do not yet carry a cryptographically bound destination-agent address. Therefore a shared team queue does not by itself ensure developer-to-developer workstation isolation.

Until per-installation dispatch addressing exists, deployments that require developer A to be unable to dispatch work to developer B's machine must use runner-local queue/trusted-actor separation. Repository collaboration, coordination peer trust, and task-dispatch trust are different authorities.

This is the highest-value remaining issue #49 security/ergonomics clarification because the system must not imply that leases solve dispatch authorization.

## Slice 0 — Foundation — complete

Implemented and retained:

- architecture/spec foundation;
- typed task/feedback/context/status protocols;
- local-authority-first capability model;
- API budget/rate primitives;
- path containment/redaction;
- shell-free process execution;
- checkpoint-and-proceed doctrine;
- durable state-store ownership boundaries.

No remaining work belongs in this slice unless a later feature reveals a foundation defect.

## Slice 1 — Managed Git workspace and publication — core complete, identity/phase hardening remains

Implemented:

- controlled Git adapter with isolated config/environment;
- managed clone/fetch/origin verification;
- per-run branches/worktrees;
- immutable start baseline (`baseSha`);
- separate advancing publication baseline (`publicationBaseSha`);
- candidate validation/sealing;
- dedicated task-branch publication;
- exact verified-head publication payload identity;
- explicit expected-remote-state CAS for first publication and rewrites;
- ambiguous publication observation/reconciliation;
- fast-forward-only upstream rebase and conflict restoration;
- no-op publication elision;
- reserved/runtime-path rejection;
- conservative lock/recovery behavior.

Remaining:

- numeric GitHub repository-ID pinning plus rename/transfer reconciliation (PP-010);
- formal bounded managed worktree/repository retention sweeper;
- first-class submodule/LFS/package-manager phase authority (PP-008);
- additional independently controlled verifier/publisher effects if product requirements expand beyond task branches.

## Slice 2 — Durable coordinator, decisions, and recovery — critical paths complete, genericization remains

Implemented:

- authoritative durable `RunCoordinator` lifecycle;
- exact task revision identity;
- duplicate terminal suppression and active-revision deferral;
- bounded result/turn protocol;
- waiting-feedback and restart resumption;
- checkpoint-and-proceed behavior;
- artifact-exact sensitive candidate classification/gating;
- exact decision provenance, TTL, supersession, and restart-safe gate state;
- safe sealing/publication rechecks;
- targeted effect reconciliation for candidate publication, update activation, chat projection, lease transitions, and other critical paths;
- baseline/local-candidate drift reverification during normal and recovery finalization.

Remaining:

- a complete generic PP-009 effect journal/reconciliation abstraction for every future remote mutation rather than targeted implementations;
- broader use of `decision-scope` automatic gating where it provides value over current stricter artifact-exact binding;
- explicit operator recovery UX for unusual poisoned/unknown remote control refs/state;
- stronger durable retention/cleanup policy across all long-lived run evidence.

## Slice 3 — GitHub progress, provenance, and context — core complete, alternate sources/auth remain

Implemented:

- coalesced bounded/redacted status projection;
- exact trusted continuation/cancel feedback provenance;
- exact trusted decision provenance;
- complete current-body/edit-history task provenance;
- durable accepted/rejected provenance evidence;
- PP-014 bounded chat handoff checkpoint/readback/latest-pointer protocol;
- authenticated handoff projection with exact digest preservation;
- compact tool-inventory projection/reference;
- rate-budgeted conditional polling with persisted validators.

Remaining:

- GitHub App installation authentication as an alternative local credential provider;
- optional webhook `TaskSource` if operational value justifies it;
- optional human-readable label mirrors where useful, never as authority;
- additional repository-ID hardening under PP-010.

## Slice 4 — Sandbox, workers, and tool authority — Linux boundary complete, platform/phase work remains

Implemented:

- local tool profiles with closed argv placeholders;
- shell-free process execution;
- allowlisted environment inheritance and mandatory control-credential stripping;
- timeout/output bounds and process-tree termination attempts;
- static/trusted-control/repository-code operation classification;
- fail-closed untrusted execution without verified outer provider;
- verified Linux Bubblewrap filesystem/network/control-state boundary;
- control-owned worker mailbox with file-identity/digest/no-follow defenses;
- external reads denied by default and selectively projected read-only;
- ordinary untrusted build/test network denial;
- truthful `doctor` separation of declarations/provider/observed enforcement;
- presence-only PATH inventory discovery;
- locally pre-authorized sandboxed tool documentation probes;
- persistent operator-owned dynamic `tool.*` manifests.

Remaining:

- verified Windows OS containment provider (Job Object/AppContainer or equivalent with matching boundary evidence);
- verified providers for other supported non-Linux platforms;
- explicit dependency fetch/install/build/test/browser phases with narrowly scoped network and cache authority (PP-008);
- lifecycle-script/package-manager policy and trust-scoped caches;
- browser/Playwright loopback/restricted-network provider if justified;
- stronger complete tool/profile identity/version evidence.

## Slice 5 — Self-update and runtime supervision — production-integrity path implemented

Implemented:

- separate supervisor and daemon runtime ownership;
- mutable development/testing channel as explicit alpha mode;
- signed immutable production release subject (repository/head/version/runtime artifact digest);
- isolated candidate materialization;
- verified sandboxed candidate preflight/tests with network denied and control state hidden;
- post-validation and pre-activation exact artifact rechecks;
- token-bound cooperative daemon drain;
- atomic tested-candidate activation intent/evidence;
- health/doctor window and last-known-good rollback;
- unexpected daemon restart on the exact accepted runtime.

Remaining:

- verified candidate-execution sandbox on Windows/non-Linux platforms;
- a formal release publication pipeline/tool if/when release operations become part of PATCH-POLLER itself;
- alternate signed release transport/provider only if justified by deployment needs.

## Slice 6 — Multi-agent coordination — first complete coordination boundary implemented

Implemented under PP-016:

- persistent local Ed25519 identity;
- public SHA-256 fingerprint/address;
- local trusted peer public keys;
- signed bounded task lease subjects;
- exact expected-value Git-ref CAS;
- heartbeat/TTL/skew recovery;
- same-identity session takeover only with exclusive local daemon-lock proof;
- lease-loss/expiry fencing before workers, sealing, and publication;
- child abort linkage where supported;
- signed terminal release state;
- coordination-enabled candidate branch namespacing.

Remaining:

- per-installation human/task dispatch addressing or another explicit routing authorization model for shared-team queues;
- operator-facing `whoami` identity display;
- peer inspection/administration UX (without letting remote content change trust);
- lease list/diagnostic CLI;
- explicit manual claim/release/recovery commands with safe expected-state semantics;
- broader observability for coordinated fleets without leaking local authority/secrets.

## Slice 7 — Baseline drift and reverification — core complete

Implemented under PP-017:

- immutable original baseline evidence;
- separate current publication baseline;
- same-ref fast-forward-only reconciliation;
- exact pre-rebase restoration after conflict;
- mandatory post-rebase model verification or deterministic replay;
- bounded reverification after candidate/local baseline drift;
- recovery-time reverification from persisted publishing state;
- exact clean verified candidate identity;
- publication bound to exact verified head;
- explicit expected remote task-branch head and ambiguity reconciliation;
- PP-016 fence preservation through publication wrappers.

Remaining work is hardening/coverage discovered through future failures rather than a known missing core feature.

## Slice 8 — Workstation governance and daemon control — cooperative core complete

Implemented under PP-018:

- effective serialized task admission;
- below-normal child priority by default;
- supported internal priority levels `normal`, `below-normal`, and `low`;
- fail-closed priority application when non-normal priority cannot be set;
- token-bound pause request/acknowledgement;
- safe-boundary admission pause preserving worktrees/run/IPC state;
- `status` requested-vs-acknowledged pause visibility;
- `resume` ownership checks;
- stop precedence while paused;
- no normal polling/claiming while fully paused.

Remaining:

- hard OS CPU/memory/disk/process-count/native-thread quotas with a real platform resource-provider contract;
- parallel scheduling only after explicit durable admission/lease/effect/liveness accounting exists;
- richer local status telemetry such as worker CPU load only when it can be measured truthfully and cheaply.

## Slice 9 — Remaining UNIX-style CLI surfaces — open issue #49 work

Currently implemented commands:

- `doctor`
- `poll-once`
- `run-once`
- `daemon`
- `status`
- `pause`
- `resume`
- `stop`
- `restart`
- `handoff-status`
- `handoff-seed`
- `handoff-project`

Remaining requested/possible controls, to be implemented only behind the already-safe underlying contracts:

- `whoami` identity display;
- trusted-peer inspection/administration;
- lease/lock listing;
- manual claim and explicit safe lease release/recovery;
- local `run --issue <id>` dry-run/simulation mode with no unintended GitHub effects;
- local `verify --patch <file.diff>` candidate verification path;
- optional structured `--json`/human output refinements where current commands do not already emit JSON.

The CLI must expose existing authority; it must not become a second capability system or a shortcut around task provenance, leases, decision gates, sandboxing, publication CAS, or recovery.

## Deferred until justified

- database-server dependency;
- arbitrary shell task format;
- remote plugin marketplace or repository-controlled plugin installation;
- paid GitHub services as a core correctness dependency;
- broad host filesystem visibility for convenience;
- parallel task execution without a first-class scheduler contract;
- automatic default-branch merge/release/deployment as an ordinary trusted task side effect.

These are not necessarily prohibited forever. They require evidence that the current simpler boundary no longer meets the workload and a design that preserves local authority.
