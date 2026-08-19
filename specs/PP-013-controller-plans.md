# PP-013 — Chat-controller deterministic execution plans

Status: active

Implementation status: implemented on current main. The PP-013 foundation, safe self-hosting, reusable deterministic infrastructure, and efficiency/observability phases have landed; later specs PP-014 through PP-018 extend this contract without replacing it.

This spec defines PATCH-POLLER's bounded, composable deterministic execution protocol. It replaces repeated bespoke diagnostic profiles as the preferred machine-work path while preserving PATCH-POLLER's control-plane authority.

Read together with PP-001, PP-003, PP-005, PP-008, PP-009, PP-010, PP-011, and PP-012. This spec does not weaken any existing security, Git, provenance, recovery, or supervision rule.

## 1. Preferred execution architecture

The preferred development and task path is:

`Primary chat controller -> PATCH-POLLER -> deterministic local operations -> verify -> seal -> publish`

The primary chat controller may author source text, tests, expected outputs, and structured execution intent. PATCH-POLLER owns local filesystem materialization, process/tool authority, runtime state, Git state, validation, cleanup, recovery, and publication.

Coding-model adapters such as Codex-family clients, Spark, or other external LLM coding tools are optional compatibility/inference adapters, not the default execution engine. They are disabled by default in the reference configuration and require explicit local enablement. Historical handoff-specific implementation constraints do not override the current user request or current specs after the PP-013 campaign has merged.

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

The implemented versioned envelope is `patch-poller/controller-plan-v1`.

The semantic ownership boundaries below are normative even if later protocol versions extend the schema compatibly.

A plan contains bounded sections for:

1. project file proposals;
2. ephemeral/test file proposals;
3. references to locally registered deterministic operations;
4. bounded assertions over operation results/files;
5. cleanup expectations;
6. final workspace assertions;
7. context/provenance expectations.

The plan itself is revision-bound task/controller data and participates in exact input/plan receipt and replay-prevention machinery.

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

For replacement/deletion, the protocol supports expected-existing-content identity where required so stale controller plans cannot silently overwrite a different revision.

Text files may use explicit expected byte representation where byte identity is part of the contract. Presentation-only newline/BOM normalization MUST NOT silently change a plan whose assertion requires exact bytes.

After all deterministic operations and ephemeral/scratch cleanup, PATCH-POLLER re-verifies every persistent controller-plan target against the exact normalized plan bytes before sealing. Persistent deletion targets must still be absent. Changed-path equality is an additional invariant, not a substitute for final-byte identity.

Operation-generated persistent output is not implicitly authorized through `expectedChangedPaths`; a future generated-output feature requires its own locally registered output contract.

### 4.2 Ephemeral files

Plans may include project-local files used only for tests/fixtures.

Every ephemeral file created by PATCH-POLLER MUST be entered into a durable cleanup ledger before or atomically with creation. Cleanup ownership therefore remains with PATCH-POLLER even if the test/process fails or the daemon restarts.

Ephemeral files MUST NOT become candidate project changes.

## 5. Deterministic operation registry

Controller plans may reference logical operation identifiers only. The operation identifier resolves through PATCH-POLLER/local configuration to a trusted adapter.

Current/foundation operation families include Node syntax/test work, CMake configure/build, CTest, native compile/link/program execution, and Git/read-only validation operations. PP-015 additionally permits locally controlled dynamic `tool.*` operations behind the same authority rules.

Each registered operation owns:

- executable/tool discovery or configured executable identity;
- allowed environment names/values;
- argument construction;
- path validation;
- timeout/output bounds;
- security classification and sandbox requirements;
- result normalization/redaction;
- operation-specific parameter schema.

A controller MAY provide validated domain parameters such as a project-relative source path, a count, a seed, a build configuration, or an expected test name when the registered adapter schema explicitly permits them. It MUST NOT provide raw argv/shell syntax that bypasses adapter policy.

Unknown future deterministic operations default to the repository-code execution class until deliberately classified otherwise. Repository-code operations require the verified OS sandbox under PP-003.

## 6. Local toolchain registry and discovery

Machine-specific toolchain identity is local authority.

PATCH-POLLER provides reusable local registry/resolution for Node, CMake, CTest, native C/C++ compiler/linker, and other locally approved deterministic tools.

Discovery/capability state is cached/reported with sanitized metadata while detecting meaningful local changes. Records may include:

- logical capability/family;
- bounded version;
- discovery source;
- health/probe state;
- sanitized supported features.

Absolute machine paths MUST NOT be projected into remote status unless explicitly safe and required; normally only family/version/capability is reported.

PP-015 specializes broader presence-only inventory and dynamic local-operation onboarding. PATH presence and tool documentation do not create executable authority.

## 7. Structured assertions

Plans need deterministic assertions without arbitrary expression evaluation.

Supported assertion classes include bounded forms such as:

- process exit equals/does-not-equal expected value;
- stdout/stderr contains or exactly equals a bounded marker;
- two captured outputs are byte-for-byte equal;
- file exists/does not exist;
- file SHA-256 equals expected digest;
- exact bounded file bytes/text;
- JSON field equals expected primitive value;
- test count/pass status;
- workspace changed paths equal an expected bounded set;
- workspace is clean after cleanup;
- context receipt matches the submitted input/revision.

Assertion evaluation is PATCH-POLLER-owned. A controller MUST NOT submit executable assertion code.

## 8. Managed scratch transaction and cleanup ledger

PATCH-POLLER makes temporary lifecycle ownership automatic.

For every run/plan it persists a cleanup ledger describing paths/resources created as ephemeral state. The lifecycle is conceptually:

`planned -> created -> observed -> cleanup-planned -> removed -> verified-absent`

Cleanup executes under success/failure/timeout/cancellation/restart recovery semantics when safe.

Cleanup may delete only:

- exact paths PATCH-POLLER registered as ephemeral for this run; or
- descendants of a locally controlled reserved scratch root created for this run.

Remote/controller content MUST NOT authorize arbitrary recursive cleanup roots.

Terminal evidence reports bounded cleanup outcome, including leftovers/failures. A cleanup failure that leaves an unexpected project artifact prevents a clean-completion claim.

## 9. Automatic context receipt

PATCH-POLLER makes exact context identity first-class rather than requiring a worker to echo context text.

Execution/terminal context carries a bounded receipt including relevant exact identities such as:

- canonical input/controller-plan SHA-256;
- task revision;
- input context sequence;
- handoff SHA-256 when present;
- run identity;
- effective baseline SHA.

The receipt is generated by PATCH-POLLER from exact input it delivered/consumed, not asserted by an external tool.

When a test needs literal payload transport verification, exact echo may still be used, but ordinary continuation relies on the receipt.

## 10. Baseline-by-channel authority

Self-hosted/testing work exposed that `main` is not always the correct task baseline.

PATCH-POLLER supports local semantic baseline channels such as `production` and `testing`.

Local configuration maps each channel to an authorized repository/ref policy. Remote/controller content may request a semantic intent only when local policy permits it; it MUST NOT grant an arbitrary raw ref/SHA.

At run creation PATCH-POLLER resolves the effective authorized baseline to one exact commit SHA and persists it as immutable start-of-run evidence.

PP-017 later adds a distinct `publicationBaseSha` that may advance through controlled fast-forward reconciliation. That does not mutate the original PP-013 `baseSha` evidence.

Do not bake a historical campaign branch name into the normative contract. The operator's current baseline-channel configuration is authoritative.

## 11. Transactional runtime activation

Moving a mutable update branch MUST NOT automatically make an unvalidated candidate the running daemon. Runtime release authority and candidate execution are separate boundaries and follow PP-010 and PP-011.

PATCH-POLLER distinguishes two release-integrity modes:

- **development/testing:** a locally configured mutable testing channel may identify candidate transport. This is explicit alpha behavior and is not production release integrity.
- **production:** mutable stable transport is not authority. Local trusted configuration MUST provide a signed immutable release manifest and Ed25519 public key binding fixed repository identity, exact 40-hex commit, package version, and exact platform-neutral runtime artifact SHA-256.

Runtime update is a transaction:

1. observe local release policy and exact current runtime;
2. resolve the candidate identity under development or independently signed production policy;
3. materialize/fetch into a separate candidate runtime location while current daemon remains available;
4. perform PATCH-POLLER-owned static/integrity checks and verify production signature/repository/head/version/artifact identity before candidate-controlled code executes;
5. verify the configured OS sandbox provider and fail closed on unsupported/unverified hosts for candidate validation;
6. run candidate preflight/tests only inside the verified sandbox with minimal environment, no control-plane credential/state access, read-only Git administration, and denied network;
7. recompute exact runtime artifact digest after validation and reject mutation; persist bounded release/artifact/sandbox evidence;
8. only after those gates pass, cooperatively drain the current daemon;
9. immediately before candidate daemon spawn, recheck exact accepted/tested artifact identity;
10. start the candidate and perform post-acceptance health/`doctor` checks;
11. mark healthy only after those checks succeed;
12. if activation/health fails, retain or restore last-known-good and preserve evidence rather than broadening authority.

Candidate `doctor` is post-acceptance health evidence, not a substitute for release integrity or sandboxed candidate validation.

Activation state/effects are subject to PP-009 durable reconciliation.

## 12. Deterministic execution is default; model execution is exceptional

Default tool/plan selection favors deterministic controller plans and local registered operations.

Coding-model profiles:

- are disabled by default;
- are never selected merely because a deterministic operation is inconvenient;
- cannot gain machine authority from remote text;
- are used only when local policy enables them and task intent requires model inference or a test targets that adapter;
- remain subordinate proposal engines under all existing Git/security rules.

There is no longer a live PP-013 implementation-campaign prohibition on all model use. Historical handoffs record that campaign's constraints; current operation follows the current user request, local policy, and these specs.

## 13. No-op publication elision

A verified task with no project diff SHOULD NOT push a task branch whose head equals its publication baseline merely to prove completion.

Default no-op completion:

- publishes terminal context/evidence;
- records candidate/base equality;
- marks publication skipped with a reason such as `no-project-diff`;
- avoids branch creation/push and associated GitHub/CI cost.

A local diagnostic/test mode may explicitly force no-op publication when publication behavior itself is under test. Remote task text alone cannot force additional publication authority.

## 14. Generic local-only fault injection

Durability testing uses a reusable PATCH-POLLER-owned fault-injection facility rather than one profile per failure scenario.

Supported deterministic fault classes may cover:

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

Test mode may use bounded time scaling for retry/backoff while preserving ordering/relative semantics. Production backoff policy is not silently changed by test scaling.

## 15. Capability doctor

PATCH-POLLER provides deterministic capability doctor coverage across core and adapter boundaries, including relevant project lifecycle, process execution, environment scrubbing, sandbox/provider evidence, locally registered operations, inventory, and profile usability.

Doctor output identifies the layer being tested so a model-adapter denial is never mistaken for PATCH-POLLER core behavior.

It MUST never print secret values, arbitrary outside file bytes, or unnecessary absolute machine paths.

PP-003/PP-015 require declared policy, configured provider, and observed enforcement to remain distinct.

## 16. Long-running liveness projection

A healthy long external operation must be distinguishable from a hang without flooding GitHub.

Coalesced active-run status carries bounded fields such as:

- current stage/activity;
- elapsed duration;
- last observed process output/activity time;
- configured deadline/timeout;
- attempt/retry state;
- owned-process alive state where safely observable.

Status mutation remains subject to PP-004 budget/pacing rules. Status reporting edits/coalesces rather than appending heartbeat comments.

## 17. Testing-channel responsiveness

Local testing configuration may use faster claim/feedback cadence when GitHub rate-limit reserves and server-provided polling guidance permit it.

Adaptive cadence preserves serialized requests, conditional validators, reserve floors, mutation pacing, and retry/reset behavior.

A local wake/nudge mechanism may be added only if it does not create an inbound untrusted control surface.

## 18. Cheap preflight before broad CI

PATCH-POLLER/self-update workflows run cheap high-signal preflight before expensive broad gates where appropriate.

Examples include changed JavaScript syntax/import validation, JSON/schema parsing, targeted tests, CMake configure, and spec/document preflight.

Full platform/project acceptance remains authoritative where required. Cheap preflight reduces wasted work; it does not replace broad acceptance.

## 19. Recovery and idempotence

All controller-plan stages are subject to PP-009:

- persist intent before dependent external effects;
- on restart, observe/reconcile before repeating;
- do not rematerialize/rerun deterministic work unnecessarily when durable evidence proves a stage complete;
- candidate verification/publication recovery uses exact recorded identities;
- cleanup resumes from the durable ledger;
- duplicate plan revision does not execute twice;
- a newer revision is deferred while an older revision of the same task remains active unless local policy says otherwise.

PP-017 additionally requires fresh bounded reverification when the publication baseline or local candidate identity drifts after prior verification.

## 20. Security invariants

PP-013 does not permit convenience shortcuts around existing boundaries.

In particular:

- PATCH-POLLER owns Git index/commit/push state.
- Controller-provided project files are proposals, not accepted source until validated/sealed.
- File paths are canonicalized/contained/no-follow checked.
- Tool resolution/environment/capabilities remain local.
- Child processes use `shell:false` unless an explicitly separate locally approved shell adapter exists; the generic controller-plan protocol never takes shell text.
- Credentials are not inherited by plan operations unless a dedicated local adapter explicitly requires/scopes them.
- Output is bounded/redacted before remote projection.
- No remote/controller plan can select an arbitrary local baseline ref, executable path, SDK path, cleanup root, credential, network capability, sandbox exception, or capability grant.
- PP-016 task leases and peer signatures do not create controller-plan/task authority.
- PP-018 process priority is local QoS and is not remotely granted through a plan.

## 21. Required acceptance coverage

The implementation must continue to prove at least these boundaries:

### File bundle / controller plan

1. Chat-authored multi-file project materializes without modifying PATCH-POLLER source to create a task-specific profile.
2. Replace/delete operations require correct expected-existing identity when configured.
3. Traversal, absolute paths, `.git`, reserved runtime paths, symlink/junction escapes, and oversized bundles are rejected.
4. Expected changed-path set and exact final persistent bytes/deletions are enforced before sealing.

### Deterministic operations

5. Registered Node operation captures exact stdout/stderr/exit.
6. Native compile -> intentional error -> repair works through generic plan operations.
7. Native link -> intentional unresolved symbol -> repair -> execution works through generic plan operations.
8. Unknown/unregistered operation and invalid parameters are rejected before process launch.

### Cleanup

9. Ephemeral test source/fixture/scratch artifacts are removed on success.
10. The same resources are recovered/cleaned after deterministic failure, timeout, and daemon restart.
11. Cleanup cannot delete an unregistered project path.

### Context

12. Terminal context includes input/plan SHA-256 receipt and correct sequence/revision without payload echo.
13. Modified/mismatched context cannot be falsely reported as matching.

### Baseline

14. Baseline channel resolves through local policy to exact immutable start SHA.
15. Raw unauthorized remote ref/SHA cannot override the baseline.
16. Upstream movement does not rewrite original start-baseline evidence; PP-017 governs publication-baseline reconciliation.

### Runtime activation

17. Development mutable-channel candidates still require verified sandboxed candidate validation; broken candidate or unavailable sandbox fails before current daemon drain.
18. Production rejects unsigned/wrong-head/wrong-version/wrong-digest transport before candidate code gains authority; candidate validation has no control credentials/state/network.
19. Artifact mutation after validation, activation failure, or health failure cannot leave the changed candidate accepted; last-known-good remains available/restored.
20. Successful production activation starts only exact signed-and-tested runtime artifact and rechecks digest at spawn boundary.

### Publication

21. No-diff task publishes terminal evidence but does not push task branch by default.
22. Changed task seals/publishes normally through current hard-gate/lease/baseline/CAS rules.
23. Forced no-op publication is possible only through local policy/testing authority.

### Fault injection/recovery

24. Named transient failure retries with persisted backoff/restart-safe behavior.
25. Result-written-then-wrapper-exit preserves conservative structured evidence.
26. Verification/publication crash windows resume without unnecessarily rerunning prior deterministic proposal work.
27. Duplicate revision does not duplicate effects.

### Capability/liveness

28. Capability doctor distinguishes PATCH-POLLER core/provider behavior from external adapter declarations.
29. Long-running fixture produces coalesced liveness state without status-comment spam.
30. Testing polling remains within GitHub budget/reserve rules.

Later specs add mandatory acceptance coverage for PP-014 handoffs, PP-015 inventory/onboarding, PP-016 leases/fencing, PP-017 drift/reverification, and PP-018 pause/process-priority behavior.

## 22. Historical implementation phases — complete

PP-013 was delivered by coherent ownership boundary:

### Phase A — controller plan foundation

- controller-plan/file-bundle parser + validation;
- deterministic operation registry;
- baseline-by-channel resolution;
- deterministic execution default/model adapters disabled by default.

### Phase B — safe self-hosting

- transactional two-mode runtime candidate validation/activation;
- verified sandboxed candidate execution;
- last-known-good retention/rollback;
- restart/effect reconciliation coverage.

### Phase C — reusable deterministic infrastructure

- toolchain registry/resolver;
- cleanup ledger/scratch transaction;
- automatic context receipt;
- no-op publication elision;
- generic local-only fault injection;
- capability doctor.

### Phase D — efficiency/observability

- coalesced liveness fields;
- adaptive testing polling;
- cheap targeted preflight before broad CI.

These phases are historical delivery structure, not pending roadmap work. Current agents should use `docs/roadmap.md` and later PP-014–PP-018 specs for remaining work.
