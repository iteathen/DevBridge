# DB-013 — Chat-controller deterministic execution plans

Status: active

Implementation status: the controller-plan foundation is implemented on current main. Repository-controlled deterministic operations currently execute through the transitional verified Linux/Bubblewrap host sandbox. DB-020 is normative for the target path: repository-controlled operations execute inside persistent untrusted repository VMs through a narrow host-controlled bridge.

This specification defines DevBridge's bounded, composable deterministic execution protocol. Read it with DB-001, DB-003, DB-008, DB-009, DB-010, DB-011, DB-012, DB-017, DB-019, and DB-020.

## 1. Preferred execution architecture

The preferred task path is conceptually:

`Primary controller -> DevBridge host control plane -> controller plan -> repository VM operations -> host validation/sealing -> host publication`

The primary controller may author source text, tests, expected outputs, and structured execution intent. DevBridge owns machine authority, VM/environment admission, source/candidate transfer, process/operation identity, durable state, authoritative Git, validation, recovery, cleanup, and publication.

Coding-model adapters are optional proposal engines, not control-plane owners. When they execute repository-controlled code or tooling, they are part of the untrusted guest trust domain unless an explicitly trusted static host adapter is proven not to execute repository content.

## 2. Core principle

> Controller plans are data, not command authority.

A controller plan may describe desired project bytes and reference locally registered deterministic operations. It is not a remote shell language and cannot grant host or guest-management authority.

Remote/controller content must not provide or grant:

- host executable paths;
- shell fragments or raw command lines;
- arbitrary environment values or credential material;
- arbitrary host paths or host mount roots;
- VM names, image paths, hypervisor targets, or management credentials;
- Git administrative commands, raw publication refs, or predecessor SHAs as authority;
- capability grants or isolation exceptions;
- arbitrary cleanup roots;
- arbitrary plugin/module loading;
- DB-016 peer keys/lease authority;
- DB-018 daemon-control/resource authority.

Local configuration and DevBridge-owned adapters remain authoritative.

## 3. Controller-plan envelope

The versioned envelope is:

`devbridge/controller-plan-v1`

A plan contains bounded sections for:

1. persistent project file proposals;
2. ephemeral/test file proposals;
3. references to locally registered deterministic operations;
4. bounded assertions over operation results/files;
5. cleanup expectations;
6. final workspace/candidate assertions;
7. context/provenance expectations.

The plan is revision-bound task/controller data and participates in exact input/plan receipt and replay-prevention machinery.

## 4. File proposals

### 4.1 Persistent project proposals

The controller may propose project-relative create/replace/delete operations.

Each proposal must:

- use a normalized repository-relative path;
- reject `..`, absolute forms, filesystem indirection escapes, `.git`, DevBridge control paths, and locally forbidden paths;
- be bounded in count and byte size;
- use an explicit supported content representation;
- be treated as proposal content until DevBridge validates/seals it under host authority.

Replacement/deletion should support expected-existing-content identity so stale plans cannot silently overwrite another revision.

The host is authoritative for the plan's intended project state. When repository execution is VM-backed, Stage 6 synchronizes the exact planned/source subject into the bound repository environment without exposing arbitrary host paths or authoritative Git administration.

After operations complete, DevBridge must validate the returned candidate against the plan's permitted persistent output contract before importing/sealing it on the host. An operation cannot create persistent host authority merely because a guest file changed.

### 4.2 Ephemeral files

Plans may include files used only for tests/fixtures.

Every ephemeral resource owned by DevBridge must be entered into durable cleanup/recovery state before or atomically with creation. In the VM design, guest-local ephemeral files can remain inside the untrusted environment during a failed run, but they must not be imported as candidate project changes unless explicitly authorized by the plan.

Host cleanup may delete only exact DevBridge-owned host transfer/scratch objects. Guest cleanup/reset remains environment-lifecycle authority and cannot be triggered by arbitrary guest path requests.

## 5. Deterministic operation registry

Plans reference logical operation identifiers only. The identifier resolves through DevBridge/local configuration to a trusted adapter.

Examples include:

- `node.syntax-check`
- `node.test`
- CMake configure/build
- CTest
- native compile/link/program operations
- bounded read-only validation operations
- locally controlled DB-015 `tool.*` operations.

Examples do not authorize unregistered operations.

Each registered operation owns:

- execution-class classification;
- locally selected host or guest executable/tool discovery policy;
- allowed environment/value construction;
- argument construction;
- path validation;
- timeout/output/liveness bounds;
- VM/provider/image/environment requirements when repository-controlled;
- result normalization/redaction;
- operation-specific parameter schema.

A controller may provide validated domain parameters such as a project-relative source path, count, seed, build configuration, test selector, or bounded enum when the adapter schema explicitly permits them. It may not provide raw argv/shell syntax.

Unknown future registered deterministic operations default to repository-controlled execution until deliberately classified otherwise.

### Execution classes

- **static/control host operation:** may execute on the trusted host only when the adapter itself cannot be redirected into repository-controlled execution through project config, plugins, hooks, loaders, shell expansion, or filesystem indirection.
- **repository-controlled operation:** target architecture executes it inside the DB-020 repository VM bound to the exact repository/guest-OS environment.

Current main still maps repository-controlled operations to the transitional host sandbox. That is implementation scaffolding, not the future contract.

## 6. Toolchain registry and discovery

Machine-specific authority is local.

Host discovery is appropriate for DevBridge prerequisites such as Node, Git, Hyper-V/provider management, and bridge/bootstrap tools. Repository toolchains such as compilers, package managers, SDKs, browsers, and coding CLIs should ultimately be discovered/used inside the persistent guest environment where their state can persist per repository/OS.

Inventory reports observed capability; it never creates authority. DB-015 owns normalized inventory, dynamic manifests, and onboarding rules.

Absolute host paths and secret-bearing details must not be projected remotely. Guest path details are likewise planning data, not authority to access the host.

## 7. Structured assertions

Plans use deterministic assertions rather than arbitrary expression evaluation.

Supported assertion classes should include:

- process exit equals/does-not-equal expected value;
- bounded stdout/stderr contains or equals a marker;
- captured outputs are byte-equal;
- guest/candidate file exists/does not exist;
- file SHA-256 equals expected digest;
- bounded exact file bytes/text;
- JSON field equals expected primitive;
- test count/pass status;
- candidate changed paths equal an expected bounded set;
- imported host candidate matches the expected output contract;
- exact context/source receipt matches the run/revision/environment subject.

Assertion evaluation and authority remain DevBridge-owned. A controller does not submit executable assertion code.

## 8. Managed scratch and cleanup

DevBridge tracks temporary lifecycle ownership explicitly.

Host-side transfer/scratch objects follow durable ownership states equivalent to:

`planned -> created -> observed -> cleanup-planned -> removed -> verified-absent`

Guest-local temporary state may be persistent across a failed operation because the repository environment itself is persistent. That does not make it a candidate change. A later run may clean guest project-local ephemeral files through a fixed adapter or reset/reseed the entire environment when policy requires it.

Cleanup must never accept an arbitrary host recursive root from controller/guest input.

Terminal evidence should report bounded cleanup/import outcomes and unexpected leftovers that affect candidate correctness.

## 9. Context and source receipt

DevBridge makes exact context identity first-class.

Each execution result/terminal context should bind:

- canonical input/controller-plan SHA-256;
- task revision;
- input context sequence;
- handoff SHA-256 when present;
- run identity;
- authoritative baseline SHA;
- repository environment identity/generation when VM-backed;
- base-image/provider identity where relevant;
- exact source-transfer identity/digest where relevant.

The receipt is generated/validated by DevBridge from the exact input delivered, not asserted solely by the guest tool.

## 10. Baseline-by-channel authority

Local semantic baseline channels such as `production` and `testing` map to authorized host repository refs/policy. Controller text cannot grant an arbitrary raw ref/SHA.

At run creation DevBridge resolves the effective authorized baseline to one exact commit and persists immutable `baseSha` evidence. DB-017 may later advance a separate `publicationBaseSha` through controlled same-ref reconciliation/reverification; it never rewrites the original start baseline.

VM source synchronization must remain bound to these host identities. A guest branch or commit cannot replace them.

## 11. Transactional runtime activation

Moving a mutable update branch must not make an unvalidated candidate the running daemon. DB-011 is authoritative.

Candidate-controlled validation must use the verified untrusted-code execution boundary. Current main uses the legacy host sandbox; DB-020 targets a VM validation environment. Release signature/artifact identity, activation, health checking, last-known-good, and rollback remain host-owned.

A candidate guest may have ordinary network access, but receives no host control credentials/state.

## 12. Deterministic execution is default; model execution is exceptional

The default plan selection policy should favor deterministic controller plans and locally registered operations.

Coding-model profiles:

- are disabled by default;
- are not selected merely because a deterministic operation is inconvenient;
- cannot gain host/VM-management authority from remote text;
- are used only when local policy enables them and task intent requires inference or a test targets that adapter;
- remain proposal engines whose output re-enters host validation/sealing.

Stage 6 owns the exact model/coding-client topology for networked guests and any authenticated-service relay. Host control-plane credentials are not copied into persistent guests for convenience.

## 13. No-op publication elision

A verified task with no project diff should not push a task branch whose head equals its current `publicationBaseSha` merely to prove completion.

Default no-op completion records terminal evidence and publication skip reason without branch creation/push. A local diagnostic may force no-op publication only when publication behavior itself is under test.

## 14. Local-only fault injection

Durability/security tests should use reusable DevBridge-owned fault injection rather than remote shell behavior.

Useful deterministic classes include operation failure, timeout, malformed/truncated result, result-written-then-wrapper-exit, candidate rejection, verification infrastructure failure, publication uncertainty, supervisor crash, cleanup failure, bridge interruption, guest shutdown/crash, and VM lifecycle ambiguity.

Authority-bearing fault configuration remains local. Remote tasks may select only predeclared safe scenarios when local testing policy permits.

## 15. Capability doctor

Doctor must distinguish requested configuration from observed capability.

For VM-backed repository execution it should eventually cover:

- hypervisor/provider availability;
- base-image identity/readiness;
- exact repository environment identity/generation and persistent-disk chain;
- bridge health/identity;
- bounded command/file roundtrip;
- absence of arbitrary host-path/secret exposure;
- guest networking readiness;
- locally registered repository operation/tool health;
- authoritative Git isolation;
- source/candidate transfer acceptance.

A configured provider or existing VM name is not enforcement evidence.

Current legacy Bubblewrap reporting must remain truthful until the VM path replaces it.

## 16. Long-running liveness

A healthy long guest operation must be distinguishable from a hang without flooding GitHub.

Coalesced status should include bounded fields such as current activity, elapsed duration, last meaningful output/progress, configured deadline, attempt, VM/environment identity reference, and whether the bridge/operation remains observable.

Status mutation remains subject to DB-004 pacing/budget rules. DB-019 owns suite-specific timing/evidence behavior.

## 17. Testing-channel responsiveness

Local testing configuration may use faster claim/feedback polling when API budgets/server pacing permit it. It must preserve serialized requests, conditional validators, reserve floors, mutation pacing, and retry/reset behavior.

A local wake/nudge mechanism may be added only if it does not create an inbound untrusted control surface.

## 18. Cheap preflight before broad qualification

Run the cheapest high-signal checks before expensive downstream suites when dependencies permit.

Documentation/schema/static plan checks should not trigger unrelated VM qualification. Conversely, VM provider/bridge/security/runtime-execution changes remain legitimate Stage-7/DB-019 qualification triggers even when expensive.

A cheap failure that already proves the candidate invalid should suppress unnecessary later expensive checks.

## 19. Recovery and idempotence

All plan/environment stages follow DB-009:

- persist intent before dependent external effects;
- observe/reconcile before repeating ambiguous effects;
- do not rerun deterministic or expensive work when exact durable evidence proves the stage complete;
- bind source/candidate transfer to exact run/repository/baseline/environment identities;
- recover interrupted bridge operations conservatively;
- do not create a second persistent repository VM because host restart lost in-memory state;
- candidate verification/publication uses exact persisted candidate/baseline identity;
- DB-017 drift invalidates stale dependent verification;
- DB-019 reuses still-valid independent evidence where identity remains applicable;
- cleanup resumes only for resources whose ownership is proven.

## 20. Security invariants

DB-013 never permits convenience shortcuts around DB-003/DB-008/DB-020.

In particular:

- authoritative Git/index/commit/push remain host-owned;
- controller project files and guest changes are proposals until imported/validated/sealed;
- host paths are never supplied by controller/guest content;
- VM/image/provider/bridge authority remains local;
- guest networking does not imply host credential/publication authority;
- child/guest process execution never gets control-plane credential variables merely because a tool requests them;
- source/candidate transfer is bounded and identity-bound;
- static host classification is fail-closed and cannot be requested by repository text;
- model/tool output cannot approve human gates, lease itself, publish, or alter VM management.

## 21. VM migration note

DB-020 and `docs/vm-migration.md` define the migration/removal sequence.

Do not remove the currently required Bubblewrap path before the VM replacement passes Stage-7 acceptance. Do not add a new AppContainer/ProcessContainer/Bubblewrap feature as the long-term repository-execution architecture. Stage 9 removes legacy host-sandbox plumbing after VM acceptance and Stage-8 setup integration.
