# DevBridge roadmap

## Current checkpoint

DevBridge has a substantial trusted host control plane: exact GitHub provenance, authoritative Git/workspaces, durable runs/recovery, controller plans, tool inventory/onboarding, checkpoint-and-proceed decisions, coordination leases/fencing, baseline-drift reverification, supervised self-update, resource priority/pause, and cost-aware verification governance.

The VM program has also completed the major security pivot away from host repository-code sandboxes. Repository-controlled execution is VM-only and fails closed when the selected VM route is unavailable.

Issue #138 corrects the persistent VM ownership model that emerged during the first VM lifecycle implementation:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

This correction is now part of the active VM roadmap. Repository count must not determine VM count.

The development-environment direction is now also explicit: a profile VM is a **persistent, adaptable development workstation**, not a disposable CI container and not an exhaustive preinstalled catalog. DevBridge supplies a capable bootstrap foundation and keeps host authority outside the guest; ordinary long-tail development tooling is prepared inside the guest using normal ecosystem mechanisms through the secure indirect guest console tracked by #214. Generic environment-state collection/packaging is tracked separately by #215 so DevBridge does not grow one diagnostic collector per technology.

See `docs/development-environment.md`.

## Active provider targets

Required host providers remain:

- Windows / Hyper-V;
- Linux / KVM-QEMU-libvirt.

Both attach through provider-neutral lifecycle/image/bridge studs. Provider-specific disk/domain/network/transport details stay in adapters.

## VM program history and current direction

### Stage 0 — architecture/spec ratification — #108 — complete

Established DB-020, provider parity, VM-only host security boundary, immutable images, host-only authority/secrets, narrow bridge contracts, and migration inventory.

The original Stage-0/DB-020 topology assumed a repository-owned persistent environment. Issue #138 supersedes that ownership assumption while preserving the VM-only security boundary.

### Stage 1 — remove host sandbox execution — #109 — complete

Removed active Bubblewrap/AppContainer/ProcessContainer-style repository execution, proved fail-closed no-provider behavior, preserved neutral execution studs, and prevented direct/uncontained host fallback.

### Stage 2 — provider/image foundation — #110 — complete

Implemented provider-local Hyper-V and KVM/QEMU/libvirt management foundations, owned storage/networking lifecycle, and immutable/versioned base-image behavior behind neutral contracts.

### Stage 3 — persistent environment lifecycle — #111 — complete historical implementation

Proved provider-native persistent lifecycle, image lineage, reset/reseed, recovery, and exact VM/domain ownership mechanics.

The original Stage 3 composition used repository identity as the persistent environment owner. That topology is now historical. Its lifecycle mechanics remain reusable because the environment `subject` contract was opaque.

Current composition supplies an execution-profile subject instead.

### Stage 4 — narrow host↔guest bridge — #112 — complete

Provides bounded command/file exchange behind provider adapters without exposing arbitrary host paths, credentials, or provider-management authority.

### Stage 5 — guest bootstrap/tooling/network — #113 — complete baseline on migration stack

Provides persistent guest preparation, networking, package-manager access, and baseline development tool behavior needed by VM execution.

Stage 5 is not intended to predict or integrate every future development tool. The follow-through is #214: a carefully secured indirect guest console that exposes ordinary development freedom only inside an exact admitted untrusted guest. Common or disproportionately difficult tooling may still be promoted into prepared images when evidence justifies it.

### Stage 6 — VM-only repository execution — #114 — complete on migration stack

Restores repository-controlled operations through persistent VM routes with host-owned source/candidate/Git authority and no direct-host fallback.

Issue #138 changes route topology so multiple repository workspaces may resolve to one physical compatible profile VM.

### Stage 7 — provider/security/recovery/resource qualification — #115 — active

Qualification now includes both original VM security claims and shared-profile workspace claims:

- real Hyper-V/KVM-libvirt provider evidence;
- no host credential/control leakage;
- provider/image/writable-layer lineage;
- restart/reset/reseed recovery;
- one profile VM serving multiple repository workspaces;
- workspace route/path/cleanup targeting;
- process/task/result isolation at the claimed boundary;
- shared-cache ownership rules;
- typed profile resource failures;
- no direct-host fallback.

Workspace scoping is not a claim that sibling workspaces survive a fully compromised/root shared guest. Separate hostile-guest trust domains require separate profiles/VMs.

When #214 lands, Stage-7 security qualification must also prove that broad guest-console capability does not weaken the host/provider boundary: guest admin/root remains guest authority only, host credentials/provider storage/lifecycle/publication remain inaccessible, and console-route failure never falls back to host execution.

### Stage 8 — setup/reconfiguration — #116 / #103 — active

Setup is discover-first and now separates:

1. host provider/image/profile readiness;
2. repository discovery/approval;
3. repository workspace routing;
4. execution enablement.

Repository `all` means all eligible workspaces, not one VM per repository. Profile provisioning is explicit/demand-driven and resource-preflighted.

Legacy repository-owned VMs are migration candidates, not silently adopted profile environments.

Setup should discover and manage **authority-bearing host/profile/prepared capabilities**, but it should not become a universal onboarding registry for every package an agent installs inside a persistent guest. Ordinary guest tooling state is allowed to evolve through #214 without requiring a new DevBridge adapter or setup flow for every package manager/tool.

### Fresh-host image supply and Windows licensing — #192 — active high-priority gate

The existing image/cache/recovery code does not by itself create a production image supply chain for a normal user. #192 adds the missing blank-slate path and is part of Stage 7/8 and whole-stack recovery acceptance.

A fresh install must assume no provider, source ISO, prepared image, product key, artifact repository, GitHub Release permission, or durable local image cache.

Keep four authorities distinct:

1. approved image construction source/recipe;
2. prepared-image distribution/storage policy;
3. Windows activation authority for a materialized VM;
4. exact execution-environment declaration.

Windows activation secrets are never base-image identity and are not embedded in generalized images or normal configuration. Host OEM/digital activation is not assumed reusable for a VM.

For GitHub-backed recovery, setup may propose a user-derived private artifact source such as `<authenticated-owner>/devbridge-base-images`; it must not hard-code the developer's repository. Remote artifacts continue to use #178's whole-image zstd encoding and 1 GiB post-compression transport chunks.

Prepared Windows bytes have a separate distribution-rights gate. When remote storage is not permitted, Windows may regenerate a canonical image locally from approved Microsoft source media plus the versioned construction recipe. Exact canonical digest reproduction may reuse the existing image subject; a different but otherwise qualified digest is a new immutable image subject/generation and requires an explicit local declaration rebind/migration before create/rebuild may consume it. Recipe equivalence never permits ignoring image identity.

Real acceptance starts with no DevBridge image cache and reaches VM-only CMake/CTest execution through supported setup/recovery surfaces. Synthetic image fixtures and manually staged workstation images are not sufficient evidence.

Issue #197's Ubuntu image is intentionally a capable foundation rather than an everything-image. It must contain enough CLI/package/build/test/network/archive/diagnostic capability to bootstrap additional ordinary tooling later, while avoiding a per-tool DevBridge acquisition framework.

See `docs/fresh-host-image-provisioning.md` and `docs/development-environment.md`.

### Stage 9 — final cleanup — #117 — pending final qualification

Remove stale sandbox-era and repository-owned-topology compatibility/documentation after migration behavior and real provider qualification are complete.

## Persistent development-environment follow-through — #214 / #215

The general development-environment strategy is now a first-class follow-through to the recovery/installability program rather than an open-ended image-expansion project.

### #214 — secure indirect guest console — high priority

The guest console is the primary extensibility mechanism for ordinary in-VM development work.

It should provide:

- `console.exec` first for bounded non-interactive guest execution;
- `console.session` later for genuine PTY/interactive needs;
- exact environment implementation-generation and workspace binding;
- explicit guest privilege class without equating guest admin/root with host authority;
- bounded stdin/stdout/stderr/time/resource behavior;
- hostile terminal/output handling;
- no host shell interpolation, host filesystem authority, provider lifecycle authority, credential forwarding, publication authority, or direct-host fallback.

The purpose is to let ordinary ecosystems solve ordinary development setup. DevBridge should not implement `installX()` paths for every language/tool/SDK merely because a future project needs it.

### #215 — generic observation packages

Environment observation should be user/project definable rather than a growing set of technology-specific DevBridge collectors.

DevBridge owns:

- bounded collector execution;
- exact environment/workspace/run identity;
- stdout/stderr and artifact bounds/digests;
- packaging;
- redaction/filtering before off-machine publication;
- replaceable transport;
- distinction between DevBridge-owned facts and guest-produced evidence.

Observation authors own what to gather and how. GitHub may serve as a coarse asynchronous transport/rendezvous for external AI/human analysis, but analysis remains advisory and cannot become authoritative test/lifecycle/publication evidence.

### GUI scope

GUI applications may be installed, launched, and used. DevBridge simply does not claim a reliable generic arbitrary-GUI interaction capability. This is a documented limitation, not an enforcement rule and not a reason to add a GUI-automation subsystem.

## Current sequencing

Do not let the new development-environment work displace the current blank-slate recovery gate.

Current order is:

1. finish the ordinary supported blank-slate/recovery chain: #197/#192 image construction and acquisition, #178/#200 publication/reacquisition, #173 missing-system-disk rebuild proof, and #201 final qualification;
2. implement and adversarially qualify #214 so a recovered persistent guest is genuinely self-preparable for arbitrary CLI-oriented development work;
3. build #215 on the same guest-execution/bridge foundation for generic state packaging and external analysis;
4. then proceed to the first real CUDA profile in #186;
5. generalize compute capability routing in #162 only after #186 proves the real hardware/profile path.

#214/#215 are not prerequisites for proving that #197 can construct an immutable base image or that #173 can reconstruct a deleted system disk. They are the high-priority usability/extensibility layer required before DevBridge should claim a broadly self-preparing general-purpose development workstation.

## Issue #138 implementation slices

The execution-profile correction is considered complete only when all of the following hold:

1. stable profile identity is independent of repository identity;
2. stable workspace identity binds repository + profile without provider leakage;
3. many workspace routes can resolve to one physical profile environment;
4. bridge operations are workspace-scoped;
5. provider adapters remain repository-agnostic;
6. selecting all repositories cannot fan out VM creation/start;
7. profile memory/resource allocation is preflighted and typed;
8. legacy repository-owned environments have explicit migration/retirement semantics;
9. docs/specs no longer present one VM per repository as the active target;
10. CI and real-provider qualification cover the new claimed boundaries.

## Execution-profile evolution

Profiles represent materially distinct platforms, not organizational grouping.

Expected examples include:

- `windows`;
- `linux`;
- `windows+cuda`;
- `linux+cuda`.

A new profile is justified only by actual compatibility/isolation/resource requirements such as OS, kernel, driver, GPU/device, licensing, architecture, or toolchain constraints.

Do not create profiles merely because repositories differ or because one repository installed another ordinary CLI package inside a compatible persistent profile.

## Workspace lifecycle follow-through

Near-term work after the basic routing correction should make workspace lifecycle first-class where needed:

- explicit workspace inventory/status;
- exact workspace reset/reseed/cleanup;
- repository-local HOME/TMP/config overlays where required;
- safe cache-sharing policy;
- migration tooling for useful old repository-owned state;
- operator-visible workspace/profile relationship in `doctor`/setup;
- task scheduling/resource accounting when multiple workspaces share one profile.

These operations must remain narrower than profile reset/delete and must not destroy sibling workspaces.

Workspace-local tooling/dependencies should be preferred when practical, while intentionally profile-level tool installations remain shared guest state. A global guest package installed for one project must not be mistaken for host authority or silently converted into a DevBridge control-plane dependency.

## Resource governance

Profile resource policy owns:

- memory/vCPU;
- host reserve/preflight;
- persistent disk growth/retention;
- active-profile/warm-pool policy;
- idle shutdown/suspend;
- GPU/device exclusivity;
- operation timeout/cancel.

Task/process limits inside a running profile may be separate. A raw repository count or `maxConcurrentTasks` value must not imply VM fleet size or a scheduler.

Persistent guest self-preparation means disk growth is expected operationally; resource governance should report/bound storage truthfully rather than treating ordinary guest package/tool growth as configuration corruption.

## Verification governance

Cost-aware verification remains control-plane authority.

Cheap checks should run before expensive provider qualification. Real VM/security claims require capable hardware; hosted CI unit/mocks are architecture evidence but do not substitute for real Hyper-V/KVM boundary qualification.

Evidence should bind relevant candidate, provider, image, profile environment, workspace, bridge, and toolchain identities so still-valid expensive evidence can be reused safely.

Guest-console output and #215 external analysis are useful evidence/input but do not by themselves replace deterministic verification acceptance. A statement such as "tests appear to pass" is not equivalent to DevBridge observing the exact admitted verification operation exit successfully.

## Setup/operator experience target

The desired setup experience is a guided review of discovered state, not a questionnaire and not a hidden VM fleet provisioner.

A useful summary is:

```text
Repositories approved: 15
Repository workspaces enabled: 15
Ready execution profiles: 1
Additional profiles required now: 0
```

For Windows, setup also keeps image/licensing state explicit without forcing irrelevant questions on Linux-only users, for example:

```text
Windows profile requested: yes
Windows source media: needed
Activation: not configured
Private recovery artifact: not configured
```

A resource-bearing change should be expressed in profile terms, for example:

```text
Create linux+cuda profile VM: 8 GiB RAM, 4 vCPU, GPU access
```

rather than as fifteen repository VM decisions.

Setup should not ask the operator to approve every ordinary guest package/tool that an authorized agent installs through #214. Setup authority remains focused on host/profile/repository/credential/prepared-capability choices that genuinely cross DevBridge control boundaries.

## Deferred/future work

After the current recovery path and #214/#215 general development-environment follow-through:

- first real CUDA execution profile (#186);
- generalized compute-capability routing (#162);
- richer profile compatibility/capability selection where materially needed;
- workspace lifecycle/migration tooling;
- resource-aware scheduling across profiles;
- optional stronger per-workspace isolation mechanisms if a real threat model requires them;
- additional providers only when justified, not for abstraction symmetry.

Do not add bespoke per-tool acquisition/collector/GUI automation frameworks merely to increase nominal technology coverage. Prefer the generic guest console, ordinary ecosystem tooling, and generic observation packages; promote common difficult prerequisites into prepared images only when operational evidence warrants it.

## Documentation authority

Current active target documents are:

- `specs/DB-020-vm-execution-boundary.md`;
- `docs/execution-profile-environments.md`;
- `docs/development-environment.md`;
- `docs/fresh-host-image-provisioning.md`;
- `docs/image-artifact-recovery.md`;
- `docs/architecture.md`;
- `docs/setup.md`;
- `docs/vm-migration.md`;
- this roadmap;
- active issues #103, #107, #115, #116, #117, #137, #138, #169–#180, #192, #197, #214, and #215.

Historical Stage 3 ownership language, old sandbox work, handoffs, tests, and PRs remain evidence but are non-normative where they conflict with the execution-profile correction, the fresh-host image/licensing plan, or the persistent development-environment approach.
