# DB-019 — Cost-Aware Verification and Durable Test Evidence

Status: active design contract; implementation tracked separately.

Implementation status: not yet implemented as a complete control-plane feature. Existing DB-013 cheap-preflight, liveness, timeout, and deterministic-recovery behavior provides partial foundations but does not yet implement the complete cost/evidence model defined here.

## Goal

DevBridge must preserve strong verification without allowing expensive tests to run accidentally, redundantly, silently, or because an agent reflexively asks to "run everything."

A test that legitimately takes 30 minutes or longer is not itself a defect. The defect is placing expensive verification on the critical path without an explicit reason, losing already-valid evidence, using one global timeout for heterogeneous workloads, or making long-running work indistinguishable from a hang.

This contract specializes DB-009 recovery, DB-013 deterministic execution/verification, DB-017 exact candidate reverification, and DB-018 workstation governance. It does not weaken any acceptance, sandbox, lease/fence, human-gate, or publication requirement.

## Governing rule

**Verification cost is controlled by DevBridge; verification sufficiency is determined by risk and exact evidence identity.**

No proposal/model may create test authority merely by requesting a broad command. Repository-defined test commands remain untrusted repository-code execution and must still pass the applicable DB-003 sandbox boundary.

## Verification tiers

Repositories and locally registered verification operations SHOULD classify checks into explicit tiers with locally controlled semantics. A useful default vocabulary is:

1. **immediate** — syntax, static invariants, schema/config parsing, cheap targeted checks; expected in seconds;
2. **affected-area** — focused tests for changed ownership boundaries and their direct contracts; usually seconds to a few minutes;
3. **integration** — subsystem combinations and cross-boundary behavior; usually minutes;
4. **full-regression** — broad repository regression coverage;
5. **qualification** — intentionally expensive platform, installer, sandbox, sanitizer, soak, hardware, release, or adversarial suites.

Tier names are descriptive, not authority. The repository/specification and local verification policy define when a tier is required.

## Risk-driven test selection

DevBridge SHOULD select verification from the changed ownership boundary, dependency/contract relationships, task class, and triggered safety rules rather than blindly running every available test.

Examples:

- documentation-only changes normally require documentation/spec/preflight checks, not an unrelated 30-minute platform qualification suite;
- sandbox/provider changes require adversarial containment and platform qualification even when those tests are expensive;
- parser/protocol changes require parser/unit coverage plus relevant downstream contract/integration checks;
- runtime/bootstrap/release changes require their dedicated activation/rollback/security gates;
- security, persistence/recovery, Git/GitHub control, public schema/protocol, installer/bootstrap, tool-discovery, and platform-execution changes SHOULD be able to trigger explicit full-qualification policy.

Risk-driven selection MUST NOT become an excuse to omit uniquely required acceptance evidence.

## Verification metadata and historical cost

A registered test/suite SHOULD expose or accumulate bounded metadata sufficient for planning, including where practical:

- stable test/suite identifier;
- verification tier/class;
- ownership area or contract tags;
- platform/toolchain/environment requirements;
- resource class such as CPU-heavy, disk-heavy, exclusive-GPU, exclusive-installer, or other locally meaningful exclusivity;
- expected/historical runtime distribution;
- timeout policy;
- whether the suite is decomposable/resumable;
- whether successful evidence can be reused and under which identity constraints.

Historical runtime is advisory planning evidence, not a correctness guarantee. Estimates may be coarse and should improve from bounded observed history.

Before launching an expensive verification plan, DevBridge SHOULD be able to summarize expected cost and why each expensive gate is required.

## Cheap/high-signal checks first

Within dependency constraints, verification SHOULD run cheaper high-signal checks before expensive downstream suites.

A failure that already proves the candidate invalid SHOULD prevent unnecessary later expensive checks for that same candidate.

This ordering may consider expected defect-detection value, consequence, and runtime cost, but the implementation does not need a complex optimizer. A deterministic locally controlled ordering policy is sufficient.

## Exact durable verification evidence

Successful verification evidence MUST bind tightly enough that DevBridge can decide whether it remains valid without asking an agent to rerun it.

At minimum, reusable evidence SHOULD bind as applicable to:

- exact candidate/head identity;
- exact `publicationBaseSha` or equivalent baseline identity;
- stable test/suite/operation identity and relevant verification-policy version;
- platform/architecture and required sandbox/provider identity;
- relevant toolchain/runtime identity or compatibility fingerprint;
- relevant configuration/profile identity;
- result/pass status, bounded timing, and evidence digest/reference.

A prior pass MUST be invalidated when an owning contract says one of those identities materially changed. DB-017 candidate/baseline drift rules remain authoritative.

A model statement that tests passed is never reusable verification evidence by itself.

## Evidence reuse and selective invalidation

DevBridge SHOULD reuse valid exact evidence instead of rerunning expensive tests merely because:

- the daemon restarted;
- a chat/controller context rolled over;
- another proposal engine asked to rerun tests;
- publication recovery re-entered an already verified stage;
- unrelated reversible work occurred without changing the verified subject.

Evidence reuse requires positive identity proof. If the candidate, relevant environment, policy, dependency contract, or required toolchain identity changed and the evidence can no longer be proven applicable, invalidate it conservatively and rerun the affected verification.

Selective invalidation is preferred to discarding all evidence when only one independently identified suite became stale.

## Long-suite decomposition and resumability

Expensive suites SHOULD be decomposed into independently identified cases/suites when their semantics allow it. Decomposition enables:

- progress visibility;
- failure localization;
- selective rerun;
- restart recovery;
- safe parallelism when later supported;
- reuse of still-valid completed evidence.

Do not artificially split tests whose shared state, ordering, timing, or isolation is part of the correctness contract.

For decomposable suites, durable progress SHOULD be recorded at the narrowest trustworthy checkpoint so restart can resume without replaying already-valid expensive work.

## Timeout model

A single global timeout is not a valid policy for heterogeneous verification.

Each locally registered verification operation/suite SHOULD own bounded timing policy appropriate to its class, including where useful:

- expected/historical runtime;
- soft slow-test threshold or warning point;
- liveness expectation;
- hard timeout/deadline;
- local hard safety ceiling.

Crossing an expected duration is not automatically failure. The hard timeout exists to bound hangs/runaway work and must remain locally controlled; remote/controller content cannot increase it.

Production code MUST NOT respond to a timeout by granting more authority, disabling containment, or silently substituting an unbounded run.

## Liveness and observability

Long-running verification must be distinguishable from a hang.

Local status SHOULD expose bounded information such as:

- current suite/test/stage when available;
- elapsed duration;
- historical/expected duration range;
- last meaningful output/progress time;
- process ownership/aliveness when safely observable;
- soft-slow and hard-timeout state;
- completed/remaining case counts for decomposable suites;
- resource class/exclusivity when useful.

Remote GitHub projection remains coalesced and rate-budgeted under DB-004. Do not create heartbeat-comment spam or project unbounded logs.

## Parallelism and resource awareness

DB-018 currently keeps task admission serialized. DB-019 does not grant general parallel task execution.

If verification parallelism is added later, it MUST be resource-aware rather than a raw concurrency number. Suites that contend for exclusive GPU, installer state, fixed ports, mutable caches, constrained RAM/disk, sandbox providers, or other shared resources must declare/receive compatible scheduling constraints.

Parallelism must never cause evidence from one candidate/run/environment to be attributed to another.

## Long verification and control-plane availability

A long verification operation should not conceptually freeze DevBridge's control plane.

Where safe and supported, unrelated read-only/control/recovery/status work may continue while expensive verification runs. Candidate-mutating work that would invalidate the evidence subject must be fenced or explicitly cause invalidation before proceeding.

Future concurrent execution must preserve DB-016 lease/fence semantics, DB-009 effect durability, and DB-018 resource accounting rather than bypassing them for throughput.

## Agent/controller interaction

Agents may recommend tests and explain expected risk, but DevBridge owns the final locally allowed verification plan, execution, evidence cache, and reuse decision.

If an agent requests an expensive suite whose exact valid evidence already exists for the current subject/environment, DevBridge SHOULD return/reference that evidence rather than automatically rerunning it.

If an agent requests "all tests," DevBridge MUST resolve that request through locally defined verification policy rather than treating natural-language breadth as unlimited process authority or cost authority.

## Qualification triggers

Repositories SHOULD be able to declare locally trusted qualification triggers for ownership areas where expensive evidence is mandatory. Examples include changes to:

- sandbox/security boundaries;
- installer/bootstrap/runtime activation;
- Git/GitHub control-plane behavior;
- persistence/recovery/effect reconciliation;
- public protocols/schemas;
- toolchain/tool-discovery authority;
- platform-specific execution providers;
- release/deployment integrity paths.

Trigger definitions are repository/local policy data subject to normal trust/provenance rules. Untrusted repository code cannot grant itself broader host capability by declaring a test requirement.

## Failure and cancellation semantics

A failed cheap prerequisite SHOULD prevent downstream expensive checks that cannot change the candidate verdict.

Cancellation, daemon stop, lease loss, timeout, or host interruption must preserve completed exact evidence and partial-suite progress when that evidence remains trustworthy. Recovery follows DB-009 observation/reconciliation before repetition.

A test failure is candidate evidence; an infrastructure failure is not automatically a candidate failure. The result model SHOULD distinguish candidate failure, infrastructure failure, timeout, cancellation/fence loss, and policy/security denial.

## Acceptance criteria for implementation

Implementation of this contract must prove at least:

- [ ] tests/suites can carry stable tier/class and locally controlled cost/timing metadata;
- [ ] verification selection can choose affected-area checks without blindly running full/qualification suites;
- [ ] explicit risk/ownership triggers can require expensive qualification where necessary;
- [ ] cheap failed prerequisites suppress unnecessary downstream expensive tests;
- [ ] successful evidence is bound to exact candidate/baseline/test/policy/environment identity;
- [ ] daemon restart/context rollover does not rerun expensive verification when exact evidence remains valid;
- [ ] candidate/baseline/relevant-environment drift invalidates only the evidence that can no longer be proven applicable;
- [ ] decomposable long suites can checkpoint/resume trustworthy completed cases without replaying the whole suite;
- [ ] per-operation soft-slow/liveness/hard-timeout policy replaces reliance on one global timeout;
- [ ] a legitimate test exceeding 30 minutes can remain healthy when its local policy/evidence says so;
- [ ] a hung test is eventually terminated by a bounded local hard timeout/process-tree policy;
- [ ] long-running verification projects bounded liveness without GitHub comment spam;
- [ ] repeated agent requests cannot force redundant expensive reruns when exact valid evidence already exists;
- [ ] `all tests`/broad natural-language requests cannot bypass locally controlled test selection/cost policy;
- [ ] evidence reuse never crosses candidate/run/environment identity boundaries incorrectly;
- [ ] future test parallelism is resource-aware and cannot be inferred from a raw concurrency value;
- [ ] cancellation/fence loss/restart preserves trustworthy evidence while preventing stale dependent effects;
- [ ] security/installer/runtime/Git/recovery/protocol/platform qualification triggers remain able to force broad expensive evidence when required.

## Non-goals

DB-019 does not require every test to be fast, set a universal 30-minute maximum, weaken full regression requirements, invent a portable resource scheduler, or allow cached evidence to survive identity changes that make it stale.

The target property is simple:

> **No expensive test runs accidentally, redundantly, silently, or without a defined reason for being on the candidate's verification path.**
