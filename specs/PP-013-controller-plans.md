# PP-013 — Chat-controller deterministic execution plans

Status: planned normative contract; implementation pending.

This spec defines the next PATCH-POLLER architecture slice derived from the 2026-08-18 durability campaign. It is intended to replace repeated bespoke diagnostic profiles with a bounded, composable, deterministic execution protocol while preserving PATCH-POLLER's control-plane authority.

Read together with PP-001, PP-003, PP-005, PP-008, PP-009, PP-010, PP-011, and PP-012. This spec does not weaken any existing security, Git, provenance, recovery, or supervision rule.

## 1. Preferred execution architecture

The preferred development and task path is:

`Primary chat controller -> PATCH-POLLER -> deterministic local operations -> verify -> seal -> publish`

The primary chat controller may author source text, tests, expected outputs, and structured execution intent. PATCH-POLLER owns local filesystem materialization, process/tool authority, runtime state, Git state, validation, cleanup, recovery, and publication.

Coding-model adapters such as Codex-family clients, Spark, or other external LLM coding tools are optional compatibility adapters, not the default execution engine. They MUST be disabled by default in the intended production configuration and MUST require explicit local enablement. During the implementation campaign governed by the handoff `docs/handoffs/PP-HO-0818-0910.md`, they MUST NOT be used unless the user explicitly changes the constraint or a test specifically targets a model adapter.

## 2. Core principle

> Controller plans are data, not command authority.

A controller plan may describe desired project bytes and reference locally registered deterministic operations. It MUST NOT become a remote shell language or a way to smuggle machine authority through trusted task text.

Remote/controller content MUST NOT provide or grant:

- executable paths;
- shell fragments or command lines;
- arbitrary environment values;
- arbitrary machine paths;
- credential locations/values;
- Git administrative commands;
- arbitrary Git refs or baseline SHAs as authority;
- capability grants;
- unbounded delete/cleanup roots;
- arbitrary plugin/module loading.

Local configuration and PATCH-POLLER-owned adapters remain the only authority for those concerns.

## 3. Controller-plan envelope

The implementation SHOULD introduce a versioned envelope such as:

`patch-poller/controller-plan-v1`

The exact JSON field names may change during implementation if a simpler schema preserves this contract, but the semantic ownership boundaries below are normative.

A plan contains bounded sections for:

1. project file proposals;
2. ephemeral/test file proposals;
3. references to locally registered deterministic operations;
4. bounded assertions over operation results/files;
5. cleanup expectations;
6. final workspace assertions;
7. context/provenance expectations.

The plan itself is revision-bound task data and participates in the task revision digest/replay-prevention machinery.

## 4. File bundle

### 4.1 Persistent project proposals

The controller may propose project-relative file operations such as create, replace, and delete.

Each proposal MUST:

- use a normalized repository-relative path;
- pass the same canonical containment/no-follow policy as all other managed workspace writes;
- be bounded in count and byte size;
- use an explicit supported encoding/content representation;
- never target `.git`, linked-worktree administrative files, PATCH-POLLER reserved runtime exchange paths, or locally forbidden paths;
- be treated as proposal content until PATCH-POLLER independently validates/seals it.

For replacement/deletion, the protocol SHOULD support an expected-existing-content digest so stale controller plans cannot silently overwrite a different revision.

Text files SHOULD support explicit expected byte representation where byte identity is part of the contract. Presentation-only newline/BOM normalization MUST NOT silently change a plan whose assertion explicitly requires exact bytes.

### 4.2 Ephemeral files

Plans may include project-local files used only for tests/fixtures.

Every ephemeral file created by PATCH-POLLER MUST be entered into a durable cleanup ledger before or atomically with creation. Cleanup ownership therefore remains with PATCH-POLLER even if the test/process fails or the daemon restarts.

Ephemeral files MUST NOT become candidate project changes.

## 5. Deterministic operation registry

Controller plans may reference logical operation identifiers only. The operation identifier resolves through PATCH-POLLER/local configuration to a trusted adapter.

Examples of useful operation classes:

- `node.syntax-check`
- `node.test`
- `npm.test`
- `cmake.configure`
- `cmake.build`
- `ctest.run`
- `native.compile`
- `native.link`
- `program.run`
- `git.read-status`
- `git.diff-check`

These names are illustrative; implementation may choose a different vocabulary.

Each registered operation MUST own:

- executable/tool discovery or configured executable identity;
- allowed environment names/values;
- argument construction;
- path validation;
- timeout/output bounds;
- process sandbox declaration/enforcement;
- result normalization/redaction;
- operation-specific parameter schema.

A controller MAY provide validated domain parameters such as a project-relative source path, a count, a seed, a build configuration, or an expected test name when the registered adapter schema explicitly permits them. It MUST NOT provide raw argv/shell syntax that bypasses adapter policy.

## 6. Local toolchain registry and discovery

Machine-specific toolchain identity is local authority.

PATCH-POLLER SHOULD provide a reusable local registry/resolver for Node, CMake, CTest, native C/C++ compiler/linker, and other locally approved deterministic tools.

Discovery SHOULD be cached with enough sanitized metadata to avoid rediscovering the same tool repeatedly while still detecting meaningful local changes. Cache entries may include:

- logical capability/family;
- bounded version;
- discovery source;
- health/probe timestamp;
- sanitized supported features.

Absolute machine paths MUST NOT be projected into remote status unless explicitly safe and required; normally only family/version/capability should be reported.

The compiler/linker logic proven in issues #12/#13 should become reusable registry adapters rather than remain a one-off diagnostic-only path.

## 7. Structured assertions

Plans need deterministic assertions without arbitrary expression evaluation.

Supported assertion classes SHOULD include:

- process exit equals/does-not-equal expected value;
- stdout/stderr contains or exactly equals a bounded marker;
- two captured outputs are byte-for-byte equal;
- file exists/does not exist;
- file SHA-256 equals expected digest;
- exact file bytes/text where bounded;
- JSON field equals expected primitive value;
- test count/pass status;
- workspace changed paths equal an expected bounded set;
- workspace is clean after cleanup;
- context receipt matches the submitted input/revision.

Assertion evaluation is PATCH-POLLER-owned. A controller MUST NOT submit executable assertion code.

## 8. Managed scratch transaction and cleanup ledger

PATCH-POLLER MUST make temporary lifecycle ownership automatic.

For every run/plan it SHOULD persist a cleanup ledger describing paths/resources created as ephemeral state. The lifecycle should be conceptually:

`planned -> created -> observed -> cleanup-planned -> removed -> verified-absent`

Cleanup MUST execute under `finally`/recovery semantics after success, failure, timeout, cancellation, or restart when safe.

Cleanup may delete only:

- exact paths PATCH-POLLER registered as ephemeral for this run; or
- descendants of a locally controlled reserved scratch root created for this run.

Remote/controller content MUST NOT authorize arbitrary recursive cleanup roots.

Terminal evidence SHOULD report at minimum:

- ephemeral resources created count;
- removed count;
- verified-absent count;
- leftovers/failures, if any.

A cleanup failure that leaves an unexpected project artifact is terminal evidence and MUST prevent a clean-completion claim.

## 9. Automatic context receipt

PATCH-POLLER MUST make exact context identity first-class rather than requiring a worker to echo context text.

Each execution result/terminal context SHOULD include a bounded receipt containing:

- canonical input/controller-plan SHA-256;
- task revision;
- input context sequence;
- handoff SHA-256 when present;
- run identity;
- effective baseline SHA.

The receipt is generated by PATCH-POLLER from the exact input it delivered/consumed, not asserted by the external tool.

When a test needs to verify literal payload transport, exact echo may still be used, but ordinary continuation should rely on the receipt.

## 10. Baseline-by-channel authority

Self-hosted/testing work exposed that `main` is not always the correct task baseline.

PATCH-POLLER MUST support local semantic baseline channels, for example:

- `production`
- `testing`

Local configuration maps each channel to an authorized repository/ref policy. Remote/controller content may request a semantic intent only if the local policy permits it; it MUST NOT grant an arbitrary raw ref/SHA.

At run creation PATCH-POLLER resolves the effective authorized baseline to one exact commit SHA and persists it. That SHA is immutable for the lifetime of the run even if the upstream branch advances.

For PATCH-POLLER self-hosting during development, local policy SHOULD allow testing tasks to resolve from the configured testing channel (`sol/foundation-bootstrap` at the time of this spec) rather than default `main` when that is the intended candidate base.

## 11. Transactional runtime activation

Moving the testing branch MUST NOT automatically make an unvalidated candidate the sole running daemon.

Runtime update should be a transaction:

1. observe candidate testing revision;
2. materialize/fetch into a separate candidate runtime location;
3. run cheap syntax/import/schema preflight;
4. run configured targeted tests/doctor;
5. run any required broader acceptance gate;
6. only after gates pass, cooperatively drain the current daemon;
7. activate the exact tested candidate SHA;
8. verify new daemon health;
9. if activation/health fails, retain or restore the last-known-good runtime and preserve evidence.

The previous runtime MUST remain available until the candidate is proven activatable. An invalid docs/code commit must not brick the supervisor merely because a branch ref changed.

Activation state/effects are subject to PP-009 durable reconciliation rules.

## 12. Deterministic execution is default; model execution is exceptional

The default tool/plan selection policy SHOULD favor deterministic controller plans and local registered operations.

Coding-model profiles:

- are disabled by default;
- are never selected merely because a deterministic operation is inconvenient;
- cannot gain machine authority from remote text;
- are used only when local policy enables them and task intent explicitly requires model inference or a test targets that adapter;
- remain subordinate proposal engines under all existing Git/security rules.

The current next-phase implementation campaign is stricter: no Codex, Spark, or other coding model is to be used.

## 13. No-op publication elision

A verified task with no project diff SHOULD NOT push a task branch whose head equals its baseline merely to prove completion.

Default no-op completion should:

- publish terminal context/evidence;
- record candidate/base equality;
- mark publication as skipped with a reason such as `no-project-diff`;
- avoid branch creation/push and associated GitHub/CI cost.

A local diagnostic/test mode may explicitly force no-op publication when publication behavior itself is under test. Remote task text alone cannot force additional publication authority.

## 14. Generic local-only fault injection

Durability testing SHOULD use a reusable PATCH-POLLER-owned fault-injection facility rather than one profile per failure scenario.

Supported deterministic fault classes may include:

- fail an operation N times with a named local classification;
- timeout before/after a durable state transition;
- malformed/truncated/BOM/fenced result fixture;
- result-written-then-wrapper-exit;
- candidate validation rejection;
- verification infrastructure failure;
- publication uncertainty/crash window;
- supervisor child crash;
- cleanup failure fixture.

Fault definitions/parameters that can alter machine authority MUST remain local test configuration. Remote task text may select only predeclared safe named scenarios when local testing policy permits.

Test mode MAY use a bounded time-scale multiplier for retry/backoff so deterministic tests run quickly while preserving ordering/relative semantics. Production backoff configuration is not changed by the test multiplier.

## 15. Capability doctor

PATCH-POLLER SHOULD provide one deterministic capability doctor covering:

- project read/write lifecycle;
- ProcessRunner exact exit/stdout/stderr behavior;
- cwd containment;
- environment scrubbing presence booleans;
- filesystem boundary read/write attempts against locally derived harmless targets;
- special writable roots such as TEMP separately from generic outside-project write;
- locally registered tool invocation health;
- profile-specific sandbox behavior.

Doctor output MUST identify the layer being tested so a model-adapter denial is never mistaken for PATCH-POLLER core behavior.

It MUST never print secret values, arbitrary outside file bytes, or unnecessary absolute machine paths.

## 16. Long-running liveness projection

A healthy long external operation must be distinguishable from a hang without flooding GitHub.

Coalesced active-run status SHOULD include bounded fields such as:

- current stage;
- elapsed duration;
- last observed process output/activity time;
- configured deadline/timeout;
- attempt number/retry state;
- whether the process is still owned/alive when safely observable.

Status mutation remains subject to PP-004 budget/pacing rules. The status reporter should edit/coalesce rather than append heartbeat comments.

## 17. Testing-channel responsiveness

Local testing configuration SHOULD permit faster claim/feedback polling than production when GitHub rate-limit reserves and server-provided `X-Poll-Interval` permit it.

The implementation may use adaptive cadence rather than a fixed fast loop. It MUST preserve serialized requests, conditional ETags, reserve floors, mutation pacing, and Retry-After/reset behavior.

A local wake/nudge mechanism may be added if it does not create an inbound untrusted control surface.

## 18. Cheap preflight before broad CI

PATCH-POLLER/self-update workflows SHOULD run the cheapest high-signal checks before expensive cross-platform or full-suite gates.

Examples:

- changed JavaScript syntax/import validation;
- JSON/schema parsing;
- targeted tests associated with changed modules;
- CMake configure for CMake/project changes;
- spec/preflight validation for changed documentation/contracts.

Full Windows/Ubuntu CI and project-defined acceptance suites remain authoritative where required. Cheap preflight reduces wasted time; it does not replace broad acceptance.

## 19. Recovery and idempotence

All controller-plan stages are subject to PP-009:

- persist intent before dependent external effects;
- on restart, observe/reconcile before repeating;
- do not rematerialize/rerun deterministic work unnecessarily when durable evidence proves the stage complete;
- candidate verification/publication restart must use the same sealed SHA;
- cleanup resumes from the durable ledger;
- duplicate plan revision does not execute twice;
- a newer revision is deferred while an older revision of the same task remains active unless local policy says otherwise.

## 20. Security invariants

PP-013 does not permit convenience shortcuts around existing boundaries.

In particular:

- PATCH-POLLER owns Git index/commit/push state.
- Controller-provided project files are proposals, not accepted source until validated/sealed.
- File paths are canonicalized/contained/no-follow checked.
- Tool resolution/environment/capabilities remain local.
- Child processes use `shell:false` unless an explicitly separate, locally approved shell adapter exists; the generic controller-plan protocol never takes shell text.
- Credentials are not inherited by plan operations unless a dedicated local adapter explicitly requires and scopes them.
- Output is bounded/redacted before remote projection.
- No remote/controller plan can select an arbitrary local baseline ref, executable path, SDK path, cleanup root, or capability.

## 21. Acceptance tests for PP-013 implementation

The implementation is not complete until at least these tests pass:

### File bundle / controller plan

1. Chat-authored multi-file project materializes without modifying PATCH-POLLER source to create a task-specific profile.
2. Replace/delete operations require correct expected-existing digest when configured.
3. Traversal, absolute paths, `.git`, reserved runtime paths, symlink/junction escapes, and oversized bundles are rejected.
4. Expected changed-path set is enforced before sealing.

### Deterministic operations

5. Registered Node operation captures exact stdout/stderr/exit.
6. Native compile -> intentional error -> repair works through generic plan operations.
7. Native link -> intentional unresolved symbol -> repair -> execution works through generic plan operations.
8. Unknown/unregistered operation and invalid parameters are rejected before process launch.

### Cleanup

9. Ephemeral test source/fixture/scratch artifacts are all removed on success.
10. The same resources are recovered/cleaned after deterministic failure, timeout, and daemon restart.
11. Cleanup cannot delete an unregistered project path.

### Context

12. Terminal context automatically includes the input/plan SHA-256 receipt and correct sequence/revision without payload echo.
13. Modified/mismatched context cannot be falsely reported as matching.

### Baseline

14. Testing channel resolves through local policy to an exact SHA and persists it immutably.
15. Raw unauthorized remote ref/SHA cannot override the baseline.
16. Upstream branch advance does not move an active run's baseline.

### Runtime activation

17. Syntax-broken candidate runtime fails preflight and the old daemon remains healthy.
18. Candidate test/doctor failure does not activate.
19. Activation failure/health failure restores or retains last-known-good runtime.
20. Successful candidate activates the exact tested SHA.

### Publication

21. No-diff task publishes terminal evidence but does not push a task branch by default.
22. Changed task seals/publishes normally.
23. Forced no-op publication is possible only through local test policy.

### Fault injection/recovery

24. Named transient failure retries with persisted backoff and restart-safe remaining delay.
25. Result-written-then-wrapper-exit preserves conservative structured evidence.
26. Verification/publication crash windows resume without rerunning prior deterministic proposal work.
27. Duplicate revision does not duplicate effects.

### Capability/liveness

28. Capability doctor distinguishes ProcessRunner behavior from external adapter behavior.
29. Long-running fixture produces coalesced liveness state without status-comment spam.
30. Testing polling remains within GitHub budget/reserve rules.

## 22. Implementation order

Implement by coherent ownership boundary, not as unrelated tiny patches:

### Phase A — controller plan foundation (P0)

- controller-plan/file-bundle parser + validation;
- deterministic operation registry interface;
- baseline-by-channel resolution;
- deterministic execution default/model adapters disabled by default.

### Phase B — safe self-hosting (P0)

- transactional candidate runtime validation/activation;
- last-known-good retention/rollback;
- restart/effect reconciliation coverage.

### Phase C — reusable deterministic infrastructure (P1)

- toolchain registry/resolver;
- cleanup ledger/scratch transaction;
- automatic context receipt;
- no-op publication elision;
- generic local-only fault injection;
- capability doctor.

### Phase D — efficiency/observability (P2)

- coalesced liveness fields;
- adaptive faster testing polling;
- cheap targeted preflight before broad CI.

Each phase MUST be implemented using the required engineering cycle in `AGENTS.md`: read specs, assess/research/reassess, plan, implement, test normal/failure/boundary behavior, then publish evidence.
