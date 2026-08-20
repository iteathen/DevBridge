# VM LEGO connection-stud and replaceability plan

Status: active migration planning contract for DB-020 / issue #107.

This document defines how the VM system must attach to DevBridge. The VM migration is not permission to route around existing architecture. It is a test of whether DevBridge's LEGO/SOLID boundaries are real.

## Governing rule

**Locate the existing connecting studs first. Attach the VM implementation to those studs.**

If replacing the repository-execution implementation requires broad rewrites of controllers, planning, Git authority, recovery, verification, worker semantics, or other consumers, treat that as evidence that the existing boundary is malformed or leaking implementation details.

Do not normalize that work as ordinary VM implementation. Repair the boundary at the owning layer, prove replaceability, then continue.

A successful migration should look like:

`controller / orchestration -> stable execution studs -> execution-provider adapter`

During migration, the same studs may have multiple adapters:

- transitional legacy host-sandbox adapter;
- Windows Hyper-V adapter;
- Linux KVM/QEMU+libvirt adapter;
- test/fake adapter.

After VM qualification, removing the legacy adapter should not require semantic changes above the stud boundary.

## Stage-1 stud discovery

Before implementing production VM providers, Stage 1 must inspect the current code and produce an exact symbol/file map for the existing repository-execution connection surface.

At minimum classify the following conceptual responsibilities:

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
- **provider-local detail** — implementation that correctly belongs entirely behind an adapter.

Known audit targets include current process-runner/sandbox-provider preparation, deterministic execution routing, worker exchange/mailbox paths, candidate validation, sandbox status/doctor vocabulary, provider selection/composition, and sandbox-specific filesystem/network projection.

The exact classification must come from the code at the Stage-1 head, not from this planning document alone.

## Fake-provider proof before Hyper-V/KVM implementation

Stage 1 must implement a minimal test/fake execution provider using only the identified studs.

The fake does not need VM security. Its purpose is architectural falsification.

It must be possible to register/select the fake and exercise representative generic controller flows without teaching those consumers about fake-provider internals.

If this requires provider-specific changes in controller/business logic, the boundary has failed the replaceability test.

Repair the boundary before Stage 2.

## Legacy-unplug proof

Stage 1 must also prove that the legacy sandbox implementation is an adapter rather than structural glue.

Provide a test/configuration/composition path in which the legacy provider is not registered. Generic control-plane modules must still load and provider-neutral tests must still pass. Provider-specific tests may of course be absent/skipped when their provider is not registered.

This is not permission to delete Bubblewrap or the transitional Windows work in Stage 1. It is a structural unplug test.

## Change-scope rule

Provider implementation belongs behind the studs.

Expected Stage-2 through Stage-5 changes are primarily:

- provider adapters;
- provider/image/environment persistence owned by the VM subsystem;
- bridge transport adapters;
- composition/registration;
- provider-specific setup/status/doctor surfaces;
- tests for those components.

If adding Hyper-V or KVM/libvirt repeatedly requires changing controller plans, authoritative Git logic, verification semantics, worker result protocol, or unrelated orchestration, stop and classify the dependency as a Stage-1 abstraction failure instead of copying the leak into both providers.

## Cutover rule

Stage 6 should switch repository execution by selecting/routing the VM-backed provider through the established studs.

Some source/candidate synchronization work is expected because the execution boundary changes from host process to guest filesystem. That synchronization must connect through the transfer/result studs rather than becoming a second VM-specific orchestration path.

A broad controller rewrite during cutover is evidence that the studs were not proven correctly.

## Stage-9 deletion test

The strongest LEGO acceptance test is removal.

After Hyper-V and KVM/libvirt are qualified and installable, Stage 9 should be able to remove the legacy sandbox family primarily by deleting:

- legacy provider adapters/helpers/probes;
- provider registration/composition entries;
- obsolete sandbox-specific configuration/migration compatibility;
- sandbox-specific tests and qualification jobs whose claims are replaced;
- obsolete provider-specific documentation.

Stage 9 should **not** need semantic rewrites of controller/orchestration/business logic merely to make the VM providers continue working.

If deletion requires such rewrites, record the dependency as an architectural defect, repair the misplaced boundary, rerun the replaceability proof, and only then resume deletion.

## Required Stage-1 artifacts

Stage 1 is not complete until it produces:

- an exact current-head stud map with symbol/file references;
- classification of each relevant legacy dependency;
- a provider-neutral contract/state model only where the existing studs are insufficient;
- a fake-provider test demonstrating attachment through the studs;
- a legacy-unplug test demonstrating generic code does not structurally require the sandbox provider;
- explicit list of leaks/missing studs repaired in Stage 1;
- a list of intentionally retained generic components;
- a bounded Stage-2 attachment surface for Hyper-V and KVM/libvirt.

## Stage gates

- **Stage 2 may not begin** until Stage 1's fake-provider and legacy-unplug proofs pass.
- **Stages 2–5** may not introduce provider-specific bypasses around the studs without reopening Stage 1's architecture decision.
- **Stage 6** must cut over primarily through provider selection/routing plus bounded source/candidate transfer integration.
- **Stage 7** must include architecture/regression evidence that generic flows work with the legacy provider disabled.
- **Stage 9** treats a need for broad core rewrites during sandbox deletion as a failed LEGO acceptance test, not expected cleanup cost.

## Success condition

The VM program has followed LEGO principles when Hyper-V and KVM/libvirt can be connected at the same stable execution boundary, a fake can fit that boundary, the legacy sandbox can be unplugged from composition without breaking generic control-plane behavior, and the old sandbox implementation can ultimately be deleted with little impact outside its own adapter/config/test surface.
