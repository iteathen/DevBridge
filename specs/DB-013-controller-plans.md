# DB-013 — Chat-controller deterministic execution plans

Status: active

Implementation status: implemented on current main. The DB-013 foundation, safe self-hosting, reusable deterministic infrastructure, and efficiency/observability phases have landed; later specs DB-014 through DB-018 extend this contract without replacing it.

This spec defines DevBridge's bounded, composable, deterministic execution protocol. It replaces repeated bespoke diagnostic profiles as the preferred machine-work path while preserving DevBridge's control-plane authority.

Read together with DB-001, DB-003, DB-005, DB-008, DB-009, DB-010, DB-011, and DB-012. This spec does not weaken any existing security, Git, provenance, recovery, or supervision rule.

## 1. Preferred execution architecture

The preferred development and task path is:

`Primary chat controller -> DevBridge -> deterministic local operations -> verify -> seal -> publish`

The primary chat controller may author source text, tests, expected outputs, and structured execution intent. DevBridge owns local filesystem materialization, process/tool authority, runtime state, Git state, validation, cleanup, recovery, and publication.

Coding-model adapters such as Codex-family clients, Spark, or other external LLM coding tools are optional compatibility adapters, not the default execution engine. They MUST be disabled by default in the intended production/reference configuration and MUST require explicit local enablement. Historical implementation-campaign restrictions recorded in `docs/handoffs/` are point-in-time constraints and are not standing prohibitions after those campaigns have merged; current user instructions, local policy, and active specs govern current work.

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
- arbitrary plugin/module loading;
- sandbox exceptions;
- DB-016 peer keys/lease authority;
- DB-018 daemon-control or priority authority.

Local configuration and DevBridge-owned adapters remain the only authority for those concerns.

## 3. Controller-plan envelope

The implemented versioned envelope is:

`devbridge/controller-plan-v1`

Future protocol versions may evolve field names only when they preserve the normative semantic ownership boundaries below.

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
- never target `.git`, linked-worktree administrative files, DevBridge reserved runtime exchange paths, or locally forbidden paths;
- be treated as proposal content until DevBridge independently validates/seals it.

For replacement/deletion, the protocol SHOULD support an expected-existing-content identity/digest so stale controller plans cannot silently overwrite a different revision.

Text files SHOULD support explicit expected byte representation where byte identity is part of the contract. Presentation-only newline/BOM normalization MUST NOT silently change a plan whose assertion explicitly requires exact bytes.

Current finalization additionally re-verifies every persistent controller-plan target after deterministic operations and ephemeral/scratch cleanup. Persistent create/replace targets MUST still equal the exact normalized planned bytes; persistent delete targets MUST still be absent. Changed-path equality is an additional invariant, not a substitute for exact final-byte identity.

Operation-generated persistent output MUST NOT become implicitly authorized through `expectedChangedPaths`; any future generated-output feature requires a separate locally registered output contract.

### 4.2 Ephemeral files

Plans may include project-local files used only for tests/fixtures.

Every ephemeral file created by DevBridge MUST be entered into a durable cleanup ledger before or atomically with creation. Cleanup ownership therefore remains with DevBridge even if the test/process fails or the daemon restarts.

Ephemeral files MUST NOT become candidate project changes.

## 5. Deterministic operation registry

Controller plans may reference logical operation identifiers only. The operation identifier resolves through DevBridge/local configuration to a trusted adapter.

Examples of useful/current operation classes include:

- `node.syntax-check`
- `node.test`
- CMake configure/build operations;
- CTest operations;
- native compile/link/program operations;
- bounded Git/read-only validation operations;
- locally controlled DB-015 `tool.*` operations.

These examples do not authorize an unregistered operation.

Each registered operation MUST own:

- executable/tool discovery or configured executable identity;
- allowed environment names/values;
- argument construction;
- path validation;
- timeout/output bounds;
- security classification and sandbox requirements;
- result normalization/redaction;
- operation-specific parameter schema.

A controller MAY provide validated domain parameters such as a project-relative source path, a count, a seed, a build configuration, or an expected test name when the registered adapter schema explicitly permits them. It MUST NOT provide raw argv/shell syntax that bypasses adapter policy.

Unknown future registered deterministic operations MUST default to the repository-code execution class until deliberately classified otherwise. Repository-code operations MUST pass the verified outer sandbox boundary under DB-003.

## 6. Local toolchain registry and discovery

Machine-specific toolchain identity is local authority.

DevBridge SHOULD provide a reusable local registry/resolver for Node, CMake, CTest, native C/C++ compiler/linker, and other locally approved deterministic tools. Current main implements this foundation.

Discovery SHOULD be cached with enough sanitized metadata to avoid rediscovering the same tool repeatedly while still detecting meaningful local changes. Cache/inventory entries may include:

- logical capability/family;
- bounded version;
- discovery source;
- health/probe state/timestamp;
- sanitized supported features.

Absolute machine paths MUST NOT be projected into remote status unless explicitly safe and required; normally only family/version/capability should be reported.

DB-015 extends this boundary with presence-only general tool inventory and locally pre-authorized dynamic operation onboarding. Binary presence or tool documentation MUST NOT create executable authority.

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

Assertion evaluation is DevBridge-owned. A controller MUST NOT submit executable assertion code.

## 8. Managed scratch transaction and cleanup ledger

DevBridge MUST make temporary lifecycle ownership automatic.

For every run/plan it SHOULD persist a cleanup ledger describing paths/resources created as ephemeral state. The lifecycle should be conceptually:

`planned -> created -> observed -> cleanup-planned -> removed -> verified-absent`

Cleanup MUST execute under recovery/finalization semantics after success, failure, timeout, cancellation, or restart when safe.

Cleanup may delete only:

- exact paths DevBridge registered as ephemeral for this run; or
- descendants of a locally controlled reserved scratch root created for this run.

Remote/controller content MUST NOT authorize arbitrary recursive cleanup roots.

Terminal evidence SHOULD report at minimum:

- ephemeral resources created count;
- removed count;
- verified-absent count;
- leftovers/failures, if any.

A cleanup failure that leaves an unexpected project artifact is terminal evidence and MUST prevent a clean-completion claim.

## 9. Automatic context receipt

DevBridge MUST make exact context identity first-class rather than requiring a worker to echo context text.

Each execution result/terminal context SHOULD include a bounded receipt containing:

- canonical input/controller-plan SHA-256;
- task revision;
- input context sequence;
- handoff SHA-256 when present;
- run identity;
- effective baseline SHA.

The receipt is generated by DevBridge from the exact input it delivered/consumed, not asserted by the external tool.

When a test needs to verify literal payload transport, exact echo may still be used, but ordinary continuation should rely on the receipt.

DB-014 later specializes coordinating-chat handoff identity; it does not replace this exact plan/context receipt.

## 10. Baseline-by-channel authority

Self-hosted/testing work exposed that `main` is not always the correct task baseline.

DevBridge MUST support local semantic baseline channels, for example:

- `production`
- `testing`

Local configuration maps each channel to an authorized repository/ref policy. Remote/controller content may request a semantic intent only if local policy permits it; it MUST NOT grant an arbitrary raw ref/SHA.

At run creation DevBridge resolves the effective authorized baseline to one exact commit SHA and persists it as immutable `baseSha` start-of-run evidence.

DB-017 introduces a separate `publicationBaseSha` that may advance only through the controlled same-ref fast-forward reconciliation/reverification path. That later publication identity MUST NOT rewrite the original DB-013 start-baseline evidence.

Do not bake a completed campaign branch name into this normative contract. The operator's current baseline-channel configuration is authoritative.

## 11. Transactional runtime activation

Moving a mutable update branch MUST NOT automatically make an unvalidated candidate the running daemon. Runtime release authority and candidate execution are separate boundaries and MUST follow DB-010 and DB-011.

DevBridge distinguishes two release-integrity modes:

- **development/testing:** a locally configured mutable testing channel may identify candidate transport. This is explicit alpha behavior and is not production release integrity.
- **production:** the mutable stable channel is transport only. Local trusted configuration MUST provide a signed immutable release manifest and Ed25519 public key binding fixed repository identity, exact 40-hex commit, package version, and exact platform-neutral runtime artifact SHA-256.

Runtime update SHOULD be a transaction:

1. observe local release policy and exact current runtime;
2. resolve the candidate identity: authorized mutable testing head in development, or independently signed immutable release subject plus matching stable transport in production;
3. materialize/fetch into a separate candidate runtime location while current daemon remains available;
4. perform DevBridge-owned static/integrity checks; in production, verify signature, repository, exact head, version, and artifact digest before executing candidate-controlled code;
5. verify configured OS sandbox provider and fail closed on unsupported/unverified hosts for candidate-controlled validation;
6. run candidate-controlled preflight/tests only inside that verified sandbox with minimal environment, no control-plane credentials/state access, read-only Git administration, and denied network;
7. recompute exact runtime artifact digest after sandbox validation and reject mutation; persist bounded release/artifact/sandbox evidence;
8. only after those gates pass, cooperatively drain current daemon;
9. immediately before candidate daemon spawn, recheck runtime artifact digest still equals exact accepted/tested digest;
10. start candidate and perform post-acceptance health window and `doctor` check;
11. mark candidate healthy only after those checks succeed;
12. if activation/health fails, retain or restore last-known-good runtime and preserve bounded evidence rather than broadening authority under uncertainty.

The previous runtime MUST remain available until the candidate is proven healthy. Candidate `doctor` is post-acceptance runtime-health evidence, not a substitute for release-integrity verification or sandboxed candidate validation.

Activation state/effects are subject to DB-009 durable reconciliation rules.

## 12. Deterministic execution is default; model execution is exceptional

The default tool/plan selection policy SHOULD favor deterministic controller plans and local registered operations.

Coding-model profiles:

- are disabled by default;
- are never selected merely because a deterministic operation is inconvenient;
- cannot gain machine authority from remote text;
- are used only when local policy enables them and task intent explicitly requires model inference or a test targets that adapter;
- remain subordinate proposal engines under all existing Git/security rules.

There is no longer a live DB-013 implementation-campaign prohibition on all model use. Historical handoffs retain the point-in-time campaign constraint; current work follows current user instructions, local policy, and active specs.

## 13. No-op publication elision

A verified task with no project diff SHOULD NOT push a task branch whose head equals its current `publicationBaseSha` merely to prove completion.

Default no-op completion should:

- publish terminal context/evidence;
- record candidate/publication-base equality;
- mark publication as skipped with a reason such as `no-project-diff`;
- avoid branch creation/push and associated GitHub/CI cost.

A local diagnostic/test mode may explicitly force no-op publication when publication behavior itself is under test. Remote task text alone cannot force additional publication authority.

## 14. Generic local-only fault injection

Durability testing SHOULD use a reusable DevBridge-owned fault-injection facility rather than one profile per failure scenario.

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

DevBridge SHOULD provide one deterministic capability doctor covering:

- project read/write lifecycle;
- ProcessRunner exact exit/stdout/stderr behavior;
- cwd containment;
- environment scrubbing presence booleans;
- filesystem boundary read/write attempts against locally derived harmless targets;
- special writable roots such as TEMP separately from generic outside-project write;
- locally registered tool invocation health;
- profile-specific sandbox/provider behavior.

Doctor output MUST identify the layer being tested so a model-adapter denial is never mistaken for DevBridge core behavior.

It MUST never print secret values, arbitrary outside file bytes, or unnecessary absolute machine paths.

DB-003/DB-015 additionally require declared profile policy, configured provider identity, and observed enforcement to remain distinct.

## 16. Long-running liveness projection

A healthy long external operation must be distinguishable from a hang without flooding GitHub.

Coalesced active-run status SHOULD include bounded fields such as:

- current stage/activity;
- elapsed duration;
- last observed process output/activity time;
- configured deadline/timeout;
- attempt number/retry state;
- whether the process is still owned/alive when safely observable.

Status mutation remains subject to DB-004 budget/pacing rules. The status reporter should edit/coalesce rather than append heartbeat comments.

## 17. Testing-channel responsiveness

Local testing configuration SHOULD permit faster claim/feedback polling than production when GitHub rate-limit reserves and server-provided `X-Poll-Interval` permit it.

The implementation may use adaptive cadence rather than a fixed fast loop. It MUST preserve serialized requests, conditional validators, reserve floors, mutation pacing, and `Retry-After`/reset behavior.

A local wake/nudge mechanism may be added if it does not create an inbound untrusted control surface.

## 18. Cheap preflight before broad CI

DevBridge/self-update workflows SHOULD run the cheapest high-signal checks before expensive cross-platform or full-suite gates.

Examples:

- changed JavaScript syntax/import validation;
- JSON/schema parsing;
- targeted tests associated with changed modules;
- CMake configure for CMake/project changes;
- spec/preflight validation for changed documentation/contracts.

Full Windows/Ubuntu CI and project-defined acceptance suites remain authoritative where required. Cheap preflight reduces wasted time; it does not replace broad acceptance.

## 19. Recovery and idempotence

All controller-plan stages are subject to DB-009:

- persist intent before dependent external effects;
- on restart, observe/reconcile before repeating;
- do not rematerialize/rerun deterministic work unnecessarily when durable evidence proves the stage complete;
- candidate verification/publication recovery MUST use exact persisted candidate/baseline identity and MUST NOT silently trust stale verification;
- DB-017 drift/rebase recovery MUST invalidate/replay verification when exact candidate or publication-baseline identity changed;
- cleanup resumes from durable ledger;
- duplicate plan revision does not execute twice;
- newer revision is deferred while older revision of same task remains active unless local policy says otherwise.

## 20. Security invariants

DB-013 does not permit convenience shortcuts around existing boundaries.

In particular:

- DevBridge owns Git index/commit/push state.
- Controller-provided project files are proposals, not accepted source until validated/sealed.
- File paths are canonicalized/contained/no-follow checked.
- Tool resolution/environment/capabilities remain local.
- Child processes use `shell:false` unless an explicitly separate, locally approved shell adapter exists; the generic controller-plan protocol never takes shell text.
- Credentials are not inherited by plan operations unless a dedicated local adapter explicitly requires and scopes them.
- Output is bounded/redacted before remote projection.
- No remote/controller plan can select arbitrary local baseline ref, executable path, SDK path, cleanup root, credential, network capability, sandbox exception, DB-016 peer/lease authority, or DB-018 daemon-control/priority authority.
- DB-016 task leases/signatures coordinate ownership only; they do not create controller-plan or trusted-task authority.

## 21. Required acceptance coverage

The implementation MUST continue to satisfy at least these boundaries:

### File bundle / controller plan

1. Chat-authored multi-file project materializes without modifying DevBridge source to create a task-specific profile.
2. Replace/delete operations require correct expected-existing identity/digest when configured.
3. Traversal, absolute paths, `.git`, reserved runtime paths, symlink/junction escapes, and oversized bundles are rejected.
4. Expected changed-path set and exact final persistent create/replace/delete identity are enforced before sealing.

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

12. Terminal context automatically includes input/plan SHA-256 receipt and correct sequence/revision without payload echo.
13. Modified/mismatched context cannot be falsely reported as matching.

### Baseline

14. Baseline channel resolves through local policy to exact SHA and persists immutable start-baseline evidence.
15. Raw unauthorized remote ref/SHA cannot override baseline.
16. Upstream movement does not rewrite original `baseSha`; DB-017 governs separate publication-baseline reconciliation/reverification.

### Runtime activation

17. Development mutable-channel candidates still require verified sandboxed candidate validation; broken candidate or unavailable sandbox fails before current daemon is drained.
18. Production rejects unsigned, wrong-head, wrong-version, or wrong-digest stable movement before candidate code can gain authority; candidate preflight/tests run without control credentials/state or network access and preserve exact tested artifact digest.
19. Artifact mutation after validation, activation failure, or health failure cannot leave changed candidate accepted; last-known-good remains available or is restored with evidence.
20. Successful production activation starts only exact signed-and-tested runtime artifact, rechecks digest at spawn boundary, and uses `doctor` only as post-acceptance health evidence.

### Publication

21. No-diff task publishes terminal evidence but does not push task branch by default.
22. Changed task seals/publishes only through current DB-007 hard-gate, DB-016 lease/fence, DB-017 verified-head/baseline, and Git-CAS rules where applicable.
23. Forced no-op publication is possible only through local test/policy authority.

### Fault injection/recovery

24. Named transient failure retries with persisted backoff and restart-safe remaining delay.
25. Result-written-then-wrapper-exit preserves conservative structured evidence.
26. Verification/publication crash windows resume without unnecessarily rerunning prior deterministic proposal work when exact evidence remains valid.
27. Duplicate revision does not duplicate effects.

### Capability/liveness

28. Capability doctor distinguishes DevBridge core/provider behavior from external adapter declarations.
29. Long-running fixture produces coalesced liveness state without status-comment spam.
30. Testing polling remains within GitHub budget/reserve rules.

Later specs add mandatory acceptance coverage for DB-014 handoffs, DB-015 inventory/onboarding, DB-016 leases/fencing, DB-017 drift/reverification, and DB-018 pause/process-priority behavior.

## 22. Historical implementation phases — complete

DB-013 was implemented by coherent ownership boundary:

### Phase A — controller plan foundation (P0)

- controller-plan/file-bundle parser + validation;
- deterministic operation registry interface;
- baseline-by-channel resolution;
- deterministic execution default/model adapters disabled by default.

### Phase B — safe self-hosting (P0)

- two-mode transactional candidate runtime release validation, sandboxed candidate execution, and activation;
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
- adaptive testing polling;
- cheap targeted preflight before broad CI.

These phases are historical delivery structure, not pending roadmap work. The required engineering cycle in `AGENTS.md` continues to govern future changes.
