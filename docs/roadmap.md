# DevBridge roadmap

## Current checkpoint

DevBridge has a substantial trusted host control plane: exact GitHub provenance, authoritative Git/workspaces, durable runs/recovery, controller plans, tool inventory/onboarding, checkpoint-and-proceed decisions, coordination leases/fencing, baseline-drift reverification, supervised self-update, resource priority/pause, and cost-aware verification governance.

The VM program has also completed the major security pivot away from host repository-code sandboxes. Repository-controlled execution is VM-only and fails closed when the selected VM route is unavailable.

Issue #138 corrects the persistent VM ownership model that emerged during the first VM lifecycle implementation:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

This correction is now part of the active VM roadmap. Repository count must not determine VM count.

The immediate priority remains recovery and installability. GPU/CUDA work must not displace the application-management, installer/setup/re-entry, reconstructable-image, VM lifecycle, or backing-store protection work required to recover a configured DevBridge installation from missing runtime/VM state.

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

### Stage 5 — guest bootstrap/tooling/network — #113 — complete on migration stack

Provides persistent guest preparation and development tool behavior needed by VM execution.

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

### Stage 8 — setup/reconfiguration — #116 / #103 — active

Setup is discover-first and now separates:

1. host provider/image/profile readiness;
2. repository discovery/approval;
3. repository workspace routing;
4. execution enablement.

Repository `all` means all eligible workspaces, not one VM per repository. Profile provisioning is explicit/demand-driven and resource-preflighted.

Legacy repository-owned VMs are migration candidates, not silently adopted profile environments.

### Stage 9 — final cleanup — #117 — pending final qualification

Remove stale sandbox-era and repository-owned-topology compatibility/documentation after migration behavior and real provider qualification are complete.

## Recovery-first prerequisite program

The original VM stages are no longer the only prerequisite for dependable repository execution. The deleted-VM-disk incident exposed a separate reconstructability gap that is now active architecture.

Before GPU work becomes an implementation priority, DevBridge should be able to recover a configured installation through supported surfaces when replaceable runtime and execution-environment state is missing.

The relevant active owners include:

- #159 / #153 — permanent entry and stale-runtime escape path;
- #180 / #182 — application-management composition and recovery-control bootstrap;
- #169–#178 — reconstructable environment/image lifecycle, including `create`, diagnosis, `rebuild`, reset/recreate, operator UX, and backing-store authority isolation;
- #116 / #103 — install/setup/re-entry and explicit local authority decisions.

The GPU roadmap is intentionally sequenced behind this recovery work. A GPU profile that cannot be recreated after a missing disk, cannot be selected through supported setup, or depends on manual hypervisor surgery is not a completed DevBridge capability.

Issue #186 is therefore a **post-recovery implementation tracker**, not current priority work.

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

Do not create profiles merely because repositories differ.

## CUDA/GPU sequence after recovery

GPU support is not one setting and should not start by building a universal compute abstraction.

The post-recovery sequence is:

1. **#186 Level 0 — real-host feasibility canary** — on the actual target host/GPU/provider combination, prove a supported/accepted device-exposure mechanism and run a real CUDA kernel inside one guest;
2. **#186 Level 1 — usable real-CUDA execution profile** — provide one reproducible CUDA-capable profile image/toolchain, provider device attachment, bounded guest attestation, `doctor`, create/rebuild behavior, and repository execution through the normal workspace route;
3. **#186 Level 2 — setup/routing integration** — allow local setup/reconfiguration to discover/propose the GPU profile and allow neutral capability requirements to select it without repository-specific branches;
4. **#162 Level 3 — generalized compute routing** — then expand source requirement detection, CPU-backed OpenCL/Vulkan functionality, framework CPU fallback, alternate hardware/cloud adapters, and common validity semantics.

A successful device listing is not enough for the first milestone. Real CUDA memory transfer + kernel execution is required.

The first real-CUDA milestone may target one provider/guest path selected by feasibility. Do not force false Windows/Linux symmetry before the underlying provider/hardware mechanisms are proven. Additional provider support remains an adapter/qualification follow-on behind the same profile and evidence contracts.

See `docs/gpu-execution-profiles.md` and #186 for the staged GPU architecture and implementation acceptance.

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

## Resource governance

Profile resource policy owns:

- memory/vCPU;
- host reserve/preflight;
- persistent disk growth/retention;
- active-profile/warm-pool policy;
- idle shutdown/suspend;
- GPU/device exclusivity or sharing policy where supported;
- operation timeout/cancel.

Task/process limits inside a running profile may be separate. A raw repository count or `maxConcurrentTasks` value must not imply VM fleet size or a scheduler.

GPU device availability is not a boolean declaration. Provider/profile qualification must distinguish host device presence, provider assignment readiness, guest visibility/runtime compatibility, real functional execution, and performance-valid evidence.

## Verification governance

Cost-aware verification remains control-plane authority.

Cheap checks should run before expensive provider qualification. Real VM/security claims require capable hardware; hosted CI unit/mocks are architecture evidence but do not substitute for real Hyper-V/KVM boundary qualification.

Evidence should bind relevant candidate, provider, image, profile environment, workspace, bridge, toolchain, and when applicable device/driver/runtime compatibility identities so still-valid expensive evidence can be reused safely.

A compile-only CUDA pass, CPU fallback, mocked device, or software GPU implementation must not be reused as evidence for real CUDA hardware execution or performance.

## Setup/operator experience target

The desired setup experience is a guided review of discovered state, not a questionnaire and not a hidden VM fleet provisioner.

A useful summary is:

```text
Repositories approved: 15
Repository workspaces enabled: 15
Ready execution profiles: 1
Additional profiles required now: 0
```

A resource-bearing change should be expressed in profile terms, for example:

```text
Create linux+cuda profile VM: 8 GiB RAM, 4 vCPU, GPU access
```

rather than as fifteen repository VM decisions.

For a GPU profile, setup should separately explain host GPU capability, provider assignment readiness, guest CUDA readiness, and the impact/exclusivity of assigning a device. Repository discovery must never silently grant GPU/provider authority.

## Deferred/future work

After recovery/installability, issue #138, and Stage 7/8 qualification:

- #186 first real-CUDA execution-profile feasibility, implementation, recovery, and operator integration;
- richer profile compatibility/capability selection where #186 exposes a genuine need;
- #162 generalized compute-requirement detection and alternate CPU/software/hardware routing after #186 proves the real-CUDA path;
- workspace lifecycle/migration tooling;
- resource-aware scheduling across profiles;
- optional stronger per-workspace isolation mechanisms if a real threat model requires them;
- additional providers only when justified, not for abstraction symmetry.

## Documentation authority

Current active target documents are:

- `specs/DB-020-vm-execution-boundary.md`;
- `docs/execution-profile-environments.md`;
- `docs/gpu-execution-profiles.md`;
- `docs/architecture.md`;
- `docs/setup.md`;
- `docs/vm-migration.md`;
- this roadmap;
- active issues #103, #107, #115, #116, #117, #138, #159, #162, #169–#182, and #186.

Historical Stage 3 ownership language, old sandbox work, handoffs, tests, and PRs remain evidence but are non-normative where they conflict with the execution-profile correction or recovery-first sequencing.