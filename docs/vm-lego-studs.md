# VM LEGO connection-stud and replaceability plan

Status: active migration planning contract for DB-020 / issue #107.

This document defines how the VM system must attach to DevBridge. The migration is intentionally **sandbox-removal first**: remove the legacy host execution boundary, leave repository-controlled execution unavailable and fail-closed, then build persistent VM providers against the exposed connection studs.

The temporary loss of repository execution is an accepted migration state. It must never be replaced with direct uncontained host execution.

## Governing rule

**Locate the existing connecting studs, unplug the old sandbox brick, prove the rest of DevBridge remains coherent, then attach the VM implementation to those studs.**

If removing the repository-execution implementation requires broad rewrites of controllers, planning, Git authority, recovery, verification, worker semantics, or other consumers, treat that as evidence that the existing boundary is malformed or leaking implementation details.

Do not normalize that work as ordinary cleanup or VM implementation. Repair the boundary at the owning layer, prove replaceability, then continue.

The intended sequence is:

`controller / orchestration -> stable execution studs -> no provider (temporary, fail closed)`

then:

`controller / orchestration -> same stable execution studs -> Hyper-V or KVM/libvirt provider`

There is deliberately no period in which the production runtime keeps both the legacy sandbox and VM providers as coequal repository-execution paths.

## Stage-1 removal and stud discovery

Before implementing production VM providers, Stage 1 must inspect the current code and produce an exact symbol/file map for the existing repository-execution connection surface.

At minimum classify these conceptual responsibilities:

1. **execution request stud** — request a bounded operation in an identified repository execution environment;
2. **input-transfer stud** — place bounded control-owned source/context/input into that environment;
3. **result-transfer stud** — return bounded untrusted result/evidence/candidate data to host-controlled staging;
4. **environment lifecycle stud** — create/observe/start/stop/reset/reseed/reconcile an execution environment;
5. **environment identity stud** — bind repository + provider + guest profile + image/environment generation;
6. **health/capability stud** — report observed provider/environment readiness and degradation;
7. **resource/cancellation stud** — apply bounded runtime/resource/cancellation behavior without exposing provider-management authority;
8. **result/evidence stud** — normalize exit/result identity and evidence without confusing guest claims with host authority.

These are conceptual targets, not permission to invent eight new interfaces mechanically. Stage 1 should prefer existing well-placed interfaces where they already provide the needed connection.

## Classify every connection

For each current sandbox/execution dependency, Stage 1 must classify it as one of:

- **valid stud** — provider-independent connection that can be retained;
- **implementation leak** — Bubblewrap/AppContainer/ProcessContainer/host-filesystem/transport detail exposed through a supposedly generic boundary;
- **missing stud** — consumer reaches directly into provider behavior because no adequate boundary exists;
- **generic retained behavior** — process capture, result classification, recovery, verification, Git authority, etc. that belongs above or beside the provider boundary and must not be duplicated;
- **provider-local detail** — implementation that correctly belongs entirely behind an adapter and can be removed with that provider.

Known audit targets include process-runner/sandbox-provider preparation, deterministic execution routing, worker exchange/mailbox paths, candidate validation, sandbox status/doctor vocabulary, provider selection/composition, sandbox-specific filesystem/network projection, setup, and CI qualification.

The exact classification must come from the code at the Stage-1 head, not from this planning document alone.

## Unplug before deletion

Stage 1 first disables/removes legacy provider registration and puts production repository execution into a deliberate **no-provider** state.

The no-provider state must be explicit and testable:

- repository-controlled operations fail before spawning repository code on the host;
- no `allowUncontainedTools`, direct-process, shell, candidate-validation, or compatibility fallback may bypass the missing provider;
- static trusted control-plane work may continue only where it is independently classified as non-repository execution;
- `doctor`, status, CLI, and recovery surfaces report repository execution unavailable rather than pretending degraded sandbox readiness is acceptable;
- durable in-flight state reconciles safely rather than retrying through a removed provider.

This state is expected to persist through Stages 2–5. Repository execution is restored only in Stage 6 through qualified-enough VM paths and is fully accepted in Stages 7–8.

## Fake-provider proof

Stage 1 implements a minimal test/fake execution provider using only the identified studs.

The fake does not provide security and must never be a production fallback. Its purpose is architectural falsification.

It must be possible to register/select the fake in tests and exercise representative generic controller flows without teaching those consumers about fake-provider internals.

If this requires provider-specific changes in controller/business logic, the boundary has failed the replaceability test. Repair the boundary before Stage 2.

## Delete the legacy sandbox in Stage 1

After the no-provider and fake-provider proofs are green, Stage 1 removes the active host-sandbox execution implementation rather than carrying it alongside the VM build.

Expected Stage-1 removal includes, where present on the exact implementation head:

- Bubblewrap provider/probe/status and provider selection;
- ProcessContainer/AppContainer/MXC/native-helper runtime remnants that are part of active code rather than historical branches;
- sandbox-specific host filesystem projection/read-root/network policy used only for repository execution;
- sandbox-specific worker IPC bind/ACL/mount transport while preserving logical worker/result protocol semantics;
- host-sandbox candidate-controlled validation paths;
- sandbox-specific qualification/setup/bootstrap wiring whose only purpose is to make repository host execution available;
- direct-host compatibility/fallback switches that would defeat the no-provider state.

Historical handoffs, audits, PR discussion, commits, and useful testing evidence are preserved. Removal means removal from active architecture/runtime, not erasing history.

## Stage-1 success test

Stage 1 is successful when DevBridge can exist coherently with **no production repository execution provider installed**.

Generic control-plane modules must load and provider-neutral controller/Git/recovery/verification tests must run without structural dependence on Bubblewrap/AppContainer/ProcessContainer.

Repository execution must fail closed and predictably. If unrelated business logic collapses when the sandbox disappears, that dependency is evidence of a misplaced connection stud.

## VM attachment rule

Stages 2–5 build the persistent VM system while repository execution remains unavailable.

Expected changes are primarily:

- provider adapters;
- provider/image/environment persistence owned by the VM subsystem;
- bridge transport adapters;
- composition/registration;
- provider-specific setup/status/doctor surfaces;
- guest bootstrap/tooling;
- tests for those components.

If adding Hyper-V or KVM/libvirt repeatedly requires changing controller plans, authoritative Git logic, verification semantics, worker result protocol, or unrelated orchestration, stop and classify the dependency as a Stage-1 abstraction failure instead of copying the leak into both providers.

## Stage-6 restoration rule

Stage 6 restores repository-controlled execution by selecting/routing a VM-backed provider through the established studs.

There is no host-sandbox fallback. If the required repository/provider/guest environment is unavailable, execution remains unavailable/fail-closed.

Some source/candidate synchronization work is expected because the execution boundary is now a guest filesystem. That synchronization must connect through the transfer/result studs rather than becoming a second VM-specific orchestration path.

A broad controller rewrite during restoration is evidence that the studs were not proven correctly.

## Qualification rule

Stage 7 re-runs the architectural falsification with the real providers present:

- fake provider still attaches through the same public studs;
- provider-neutral flows still do not require a legacy sandbox module;
- Hyper-V and KVM/libvirt do not leak provider-specific commands/paths into generic consumers;
- repository execution has no direct-host fallback;
- repository-wide dependency review finds no resurrected sandbox architecture.

Successful VM workloads alone are not enough; replaceability remains an acceptance criterion.

## Stage-9 final-cleanup test

Because the active sandbox is removed in Stage 1, Stage 9 is no longer the sandbox deletion stage. It is the final migration cleanup after VM qualification/setup.

Stage 9 may remove or simplify:

- temporary no-provider migration diagnostics/scaffolding that are no longer needed once VM setup is the normal path;
- obsolete sandbox-era config keys and migration compatibility after Stage 8 has a deliberate migration story;
- stale sandbox terminology in active docs/status schemas;
- dead tests/CI compatibility preserved only to bridge the migration;
- historical PR #106 from the active work queue, while preserving history.

If Stage 9 discovers active sandbox runtime code still required for normal repository execution, the earlier migration has failed and must not be papered over.

## Required Stage-1 artifacts

Stage 1 is not complete until it produces:

- an exact current-head stud map with symbol/file references;
- classification of each relevant legacy dependency;
- explicit list of abstraction leaks/missing studs repaired;
- a production no-provider/fail-closed repository-execution state;
- a fake-provider test demonstrating attachment through the studs;
- proof generic code remains coherent with no production repository execution provider;
- removal of the active legacy host-sandbox execution implementation and direct-host fallbacks;
- an intentionally retained generic-components list;
- a bounded Stage-2 attachment surface for Hyper-V and KVM/libvirt;
- an exact list of sandbox-era configuration/documentation compatibility deferred to Stage 8/9 rather than active execution code.

## Stage gates

- **Stage 2 may not begin** until Stage 1 has removed the active legacy host-execution provider, established fail-closed no-provider behavior, and passed fake-provider/generic-control-plane proofs.
- **Stages 2–5** build VM capability while production repository execution remains unavailable; they may not introduce temporary direct-host execution.
- **Stage 6** is the only planned restoration of repository-controlled execution and must use persistent VM providers through the established studs.
- **Stage 7** verifies security, real-provider behavior, and architectural replaceability with no sandbox fallback.
- **Stage 8** makes VM execution installable/reconfigurable and migrates obsolete sandbox-era configuration deliberately.
- **Stage 9** removes remaining migration scaffolding/obsolete configuration and confirms one coherent VM-only repository-execution architecture.

## Success condition

The migration has followed LEGO principles when DevBridge remains structurally coherent after the old sandbox brick is physically removed, repository execution fails closed during the provider gap, Hyper-V and KVM/libvirt later connect at the same stable execution boundary, a fake can fit that boundary, and restoring repository execution requires provider attachment/routing rather than rebuilding unrelated control-plane logic.