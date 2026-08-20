# DB-020 — Persistent VM Execution Boundary

Status: active architecture contract; implementation is staged by issues #107 through #117.

Implementation status: Stages 0 and 1 are implemented by the VM migration candidate. Active Bubblewrap/AppContainer/ProcessContainer-style host repository execution has been removed. Production composition intentionally has no repository execution provider and reports repository execution unavailable/fail-closed. `src/runtime/repository-execution.js` is the provider-neutral Stage-2 attachment surface. Stages 2–5 build VM capability without restoring normal repository execution; Stage 6 restores it only through persistent VM providers.

## Goal

Make a persistent virtual machine the sole required security boundary for repository-controlled execution while keeping DevBridge's authoritative control plane, secrets, Git/publication authority, and recovery state on the trusted host.

The initial provider set is deliberately **two-host-platform**, not Windows-only:

- **Windows host:** Hyper-V.
- **Linux host:** KVM/QEMU managed through libvirt.

Both are first-class target providers. The common DevBridge control plane must not assume Hyper-V, PowerShell, VHDX, libvirt, qcow2, or one bridge transport outside the provider adapter that owns those details.

The guest model remains repository-centric: each approved repository receives a persistent environment for each enabled guest OS/profile. Windows and Linux guest profiles must be representable on either host provider where the local provider/image/licensing prerequisites are available. Stage 7 owns the exact cross-provider qualification matrix and must not claim a host/guest combination that has not been tested.

Additional hypervisors may be added later only behind the same contracts; they are not required for the first complete implementation.

## Precedence

For repository-controlled execution, this specification supersedes earlier active documentation that treats Bubblewrap, AppContainer, ProcessContainer, host path allowlists, Gitless host projections, or another host-process sandbox as the target security boundary.

Earlier DB-003, DB-008, DB-011, DB-013, DB-015, setup/bootstrap, tool-profile, and roadmap descriptions remain useful where they describe migration compatibility or provider-independent invariants. Where they conflict with this contract's repository-execution architecture or migration sequence, DB-020 governs.

Historical handoffs, audits, and PR #106 remain historical engineering evidence. They do not regain normative authority merely because their mechanisms existed before removal.

## Core rule

**Repository-controlled code executes in an untrusted VM. If no qualified/admitted VM execution provider is available, repository-controlled execution does not occur. It never falls back to direct or uncontained host execution.**

A guest administrator/root compromise must not grant access to:

- GitHub credentials or credential brokers;
- coordination private keys or lease-signing authority;
- release/signing keys, manifests, or activation authority;
- authoritative Git administration, task-branch publication, or default-branch promotion authority;
- DevBridge daemon locks, durable run/control state, checkpoints, decisions, or recovery journals;
- host operator credentials, SSH agents, token-bearing environment variables, or user-home secrets;
- hypervisor/VM-management authority;
- arbitrary host paths or writable host mounts.

Repository content, dependencies, package scripts, build systems, tests, coding-worker subprocesses, browser tooling, generated tools, and guest-local Git are all inside the same untrusted guest trust domain unless a later specification deliberately narrows a sub-boundary.

No required Bubblewrap, AppContainer, ProcessContainer, or equivalent second sandbox exists inside the guest. Defense-in-depth guest hardening is allowed only if it does not become a hidden prerequisite for the host/guest security claim.

## Intentional no-provider migration state

Stage 1 removed the active legacy host-sandbox execution implementation before production VM implementation began.

From that removal until Stage 6 restores repository execution through VMs:

- no production repository execution provider is registered/admitted;
- repository-controlled operations fail closed before spawning repository code on the host;
- `allowUncontainedTools`, compatibility modes, candidate validators, shells, or direct process runners must not create an alternate host execution path;
- trusted static/control-plane operations may continue only where they are independently classified as not executing repository-controlled code;
- `doctor`, CLI, status, recovery, and setup surfaces report repository execution unavailable rather than inventing sandbox readiness;
- durable in-flight effects that depended on the removed provider reconcile safely and cannot be retried through an unsafe fallback.

This temporary capability gap is deliberate. It is also a LEGO replaceability test: DevBridge's generic controller/Git/recovery/verification architecture remains coherent without any production repository execution provider installed.

The Stage-1 execution stud is intentionally implementation-neutral. Generic callers exchange repository/run identity, logical operation/tool identity, bounded arguments, environment-relative locations, transfer capabilities, cancellation/activity, and normalized results. They do not exchange host executable paths, host process runners, sandbox/VM names, mailbox paths, mounts, or provider transport details.

## Terminology

- **trusted host** — the machine/OS context in which the DevBridge controller and the selected VM-provider adapter hold local authority.
- **VM provider** — the host-specific virtualization backend: initially Hyper-V on Windows or KVM/QEMU+libvirt on Linux.
- **repository environment** — one persistent execution environment bound to one authoritative repository identity plus one enabled guest OS/profile identity.
- **guest** — the VM OS and all software/state inside a repository environment. The guest is untrusted.
- **base image** — an immutable/versioned OS+bootstrap/tooling disk identity from which repository environments are derived.
- **child/overlay disk** — the persistent per-repository/per-OS writable layer based on an immutable image: Hyper-V differencing VHD/VHDX or KVM/QEMU qcow2 backing/overlay semantics where supported.
- **bridge** — the narrow host-controlled command/file exchange used to operate a guest without exposing arbitrary host filesystem authority.
- **authoritative Git** — host-owned repository/worktree/ref state used for provenance, candidate sealing, reconciliation, and publication.
- **guest Git** — ordinary development Git state inside the guest. It is disposable/untrusted and never publication authority.

## Authority partition

### Host-owned authority

The trusted host owns:

- task/feedback/decision provenance and local authorization;
- stable repository identity and repository-to-environment mapping;
- immutable base-image registry and image compatibility policy;
- VM creation/start/stop/reset/reseed/delete authority;
- bridge endpoint identity and command/file admission;
- GitHub API credentials and Git transport credentials;
- DB-016 coordination identity/private keys and lease/fence evaluation;
- authoritative repository clone/worktree/ref state;
- candidate import, validation identity, sealing, commit creation, push/publication, and later merge/release authority;
- DB-007 human-decision authority and exact approval subjects;
- DB-009 durable effect/recovery state;
- DB-019 verification policy/evidence authority;
- runtime update/release/signing authority;
- daemon lifecycle/control state.

The guest may observe bounded non-secret inputs derived from these authorities, but it never owns or widens them.

### Guest-owned persistent but untrusted state

A repository environment may persist ordinary development state such as:

- source working bytes supplied by the host;
- build trees, dependency caches, package installations, SDK/tool installations permitted by guest policy;
- guest-local configuration that contains no host secret;
- test/browser artifacts;
- guest Git metadata and local branches/remotes that are not authoritative publication state;
- coding-worker scratch/results that will later cross the bridge as untrusted data.

Persistence does not convert guest state into authority.

## Threat model

The security design must remain correct if repository-controlled execution obtains administrator/root in the guest, replaces guest tools, tampers with guest Git, modifies guest startup/services, persists across reboots, controls every guest-local file, forges guest protocol responses, and uses normal network access to exfiltrate anything present in the guest.

Therefore confidentiality is achieved primarily by **not placing host secrets in the guest**, not by assuming guest egress filtering will contain a compromised process.

Hypervisor escape, host kernel compromise, firmware compromise, or a defect in the selected hypervisor security boundary is outside DevBridge's software-only containment claim. Provider qualification must nevertheless use supported host/hypervisor configurations and treat unsafe/unknown capability state as unavailable.

## Persistent repository/OS identity

A repository environment is persistent per stable repository identity and enabled guest OS/profile. Human-readable `owner/name` remains useful routing/display metadata but must not be the sole durable environment identity because repositories can be renamed or transferred. The Stage-1 execution request can carry a verified immutable repository ID when available; later environment stages must bind durable VM identity to that stable subject rather than display name alone.

The durable environment identity must also bind at least:

- host provider identity;
- guest OS/profile identity;
- base-image identity/version/generation;
- environment generation;
- child/overlay disk identity;
- lifecycle/recovery state;
- bridge generation/version where relevant.

Changing a display name does not silently create a second environment. Changing a security- or compatibility-relevant provider/image/profile identity does not silently reuse incompatible state.

## Base images and persistent writable layers

Base OS/tooling images are immutable and versioned. A repository environment must not mutate its parent/base image in place.

### Windows / Hyper-V

The intended storage model uses immutable base VHD/VHDX images and per-repository differencing disks where Hyper-V supports the required semantics.

### Linux / KVM-QEMU-libvirt

The intended storage model uses immutable base images and qcow2 overlays/backing-file chains. QEMU's qcow2 backing-file model provides the same architectural property required by DevBridge: the guest writes to the overlay while unallocated reads resolve to the immutable backing image.

### Common rules

The controller tracks the exact parent/backing relationship and fails closed on an unexplained or incompatible chain. Base-image updates create a new image identity; they do not silently rewrite the parent/backing image beneath existing repository state.

A provider may use another proven copy-on-write/clone primitive, or a dedicated full disk when necessary, only if it preserves the same isolation, identity, immutability, persistence, and recovery semantics.

## Lifecycle and persistence

Process lifetime, VM runtime lifetime, and repository-disk lifetime are separate concepts.

- Completing, timing out, or cancelling one command must not delete the repository environment.
- Stopping or shutting down the VM must retain its persistent writable layer.
- Host/daemon restart must rediscover and reconcile the existing environment rather than silently provisioning a second one.
- A crashed/unreachable VM is an infrastructure/recovery condition, not permission to discard state.
- Reset/reseed is an explicit control-plane action that discards an environment generation and reconstructs it from a trusted base plus authoritative source inputs.
- Deletion is ownership-bound and must never be inferred from a guest request or an ambiguous provider observation.

DB-009's observe/reconcile-before-repeat rule applies to VM create/start/stop/reset/reseed/delete and bridge effects where ambiguity can exist.

Provider adapters translate common lifecycle state into actual Hyper-V or libvirt/QEMU observations rather than pretending both platforms expose identical raw states.

## Guest networking

Repository guests have normal network connectivity by default.

This is deliberate. Development environments routinely need package registries, SDK installers, documentation, source fetches, test endpoints, browser access, and coding-service traffic. DevBridge must not make a custom deny-by-default egress proxy a prerequisite for normal repository execution.

Because guest egress is normally available:

- any secret placed in the guest must be assumed exfiltratable;
- host GitHub, coordination, release/signing, daemon, and VM-management secrets must never be injected for convenience;
- network availability is not evidence that a guest has host authority;
- disabling guest networking may exist as an optional workload/policy mode, but it is not the normal security basis.

Hyper-V and KVM/libvirt networking are provider implementation details. Stage 5 must verify practical DNS/HTTPS/package-manager/source access on both supported host-provider families without exposing arbitrary host shares or control credentials.

Private-source and authenticated-service workflows must use later explicit mechanisms that preserve the host-only authority rule. Stage 6 owns the exact coding/model-adapter topology and any scoped credential relay design; this spec does not authorize copying host tokens into guests.

## Narrow host↔guest bridge

DevBridge operates guests through a narrow host-controlled bridge rather than arbitrary shared host directories.

The bridge contract must support the minimum required classes of exchange:

- start a locally admitted guest command/operation;
- pass bounded structured input/context;
- transfer bounded files or source snapshots into the guest;
- retrieve bounded result/evidence/candidate files from the guest;
- observe command exit, timeout/cancellation, and bounded output/liveness;
- identify the exact provider, repository environment, and operation/run subject.

The bridge must not allow guest-controlled input to name arbitrary host filesystem paths, host executables, Git refs, credential locations, VM-management targets, or control-state objects. Host paths remain host-local implementation details; bridge messages use bounded logical identities/relative guest paths/opaque transfer objects.

The transport is intentionally not selected by Stage 0.

Relevant researched provider primitives include:

- Hyper-V host/guest integration channels, Hyper-V sockets, and Windows-specific PowerShell Direct;
- libvirt/QEMU virtio channels, QEMU Guest Agent, and vsock-capable guest-agent transport.

QEMU Guest Agent is explicitly not a trusted guest oracle: a compromised guest may forge or manipulate responses. That matches DB-020's threat model; the host must still validate all returned data and keep bridge authority one-way/host-controlled. Stage 4 selects the concrete transport(s), allowed command subset, framing, cancellation, file-transfer strategy, recovery, and protocol version for both provider families.

The bridge itself is not publication authority. Guest output is untrusted until the host validates it under the owning protocol.

## Source, candidate, and Git model

Authoritative Git remains host-owned.

A normal repository workflow after Stage 6 is conceptually:

1. the host resolves trusted task/repository/baseline identity;
2. the host prepares authoritative source state without giving the guest GitHub credentials;
3. source/input is synchronized into the persistent repository environment through the bridge;
4. repository-controlled commands/workers operate inside the guest;
5. the guest returns candidate bytes/results/evidence through the bridge;
6. the host validates the returned subject against the expected source/baseline/run identity;
7. the host applies/imports accepted candidate bytes into authoritative Git state;
8. the host performs required verification/evidence reconciliation, sealing, commit creation, and publication.

Guest Git may be useful for developer tooling, but guest refs/remotes/index/config/hooks are untrusted data. A guest `git commit` or `git push` cannot satisfy DevBridge publication requirements.

The exact incremental synchronization and conflict/drift protocol belongs to Stage 6. It must preserve DB-017 baseline identity and must not allow the guest to overwrite authoritative host Git state through a writable mount.

## Execution routing

Stage 1 removed the host-sandbox repository-execution route. Stages 2–5 do not restore repository task execution through an interim host mechanism.

After Stage 6 restoration, repository-controlled execution classes must use the repository VM boundary. This includes, as applicable:

- deterministic build/test/tool operations that execute repository-controlled code/config/plugins;
- proposal/coding-worker command execution;
- package-manager and dependency lifecycle execution;
- browser/integration tooling driven by repository content;
- generated/local-manifest `tool.*` wrappers whose execution class is repository-controlled;
- repository-specific compiler/build/test invocations;
- DevBridge candidate-controlled validation where the candidate itself is untrusted executable code, using an appropriate VM environment rather than host sandboxing.

Pure control-plane parsing, cryptographic verification, GitHub API operations, authoritative Git operations, VM management, deterministic transformations that provably do not execute repository-controlled code, and other trusted static adapters may remain on the host.

The classification decision remains DevBridge-owned. A repository cannot label its own executable operation `safe host`, and provider unavailability cannot silently change an operation from repository-controlled to host-safe.

## Tooling and development environment behavior

Persistent VMs replace the target use of `workspace.externalReadRoots`, host PATH exposure, and sandbox-specific filesystem grants for repository execution. Repository tools should be installed or discovered inside the guest environment, where their presence and state can persist for that repository/OS.

Host-side tool inventory remains useful for control-plane tools and provider/bootstrap prerequisites. On Windows that includes Hyper-V management prerequisites; on Linux it includes KVM/QEMU/libvirt/provider prerequisites. Guest tool inventory is untrusted observation used for planning and verification, not authority to run arbitrary host commands.

DB-015 automatic onboarding must ultimately probe and execute repository-class tools in the guest. Its safe schema/manifest/projection rules remain reusable. During the Stage-1-to-Stage-5 no-provider interval, repository-class probes that require execution are unavailable rather than redirected to the host. Existing control-owned manifests may be parsed and registered, but registration does not imply repository execution readiness.

## Runtime candidate validation

DevBridge self-update candidates are untrusted until accepted. Stage 1 removed candidate-controlled host execution together with the host repository-execution boundary.

Static release/signature/artifact checks remain host-owned. Until Stage 6 provides VM candidate execution, any validation step that would execute candidate-controlled code is unavailable/fail-closed; a healthy currently accepted runtime remains in service rather than granting the candidate host authority. DB-011's exact release-subject, artifact-digest, last-known-good, activation, and rollback rules remain authoritative throughout the gap.

A runtime candidate environment does not need the same long-lived per-repository persistence semantics as ordinary project environments; Stage 6 may use a dedicated/reseedable VM workflow as long as candidate code receives no host control authority and the exact accepted artifact is still the exact activated artifact.

The restored validation environment should use the provider native to the host: Hyper-V on Windows, KVM/QEMU/libvirt on Linux.

## Verification and `doctor`

Configuration declarations do not prove VM isolation.

During the no-provider interval, `doctor` explicitly reports repository-code execution unavailable. It does not infer host execution readiness from legacy config fields or silently reactivate a removed sandbox.

Before DevBridge reports repository-code execution usable after Stage 6, Stage 7 must establish observed evidence for at least:

- selected provider/hypervisor availability and supported host configuration;
- exact base-image identity and parent/backing-chain integrity;
- exact repository-environment identity and lifecycle reconciliation;
- bridge identity/framing and bounded transfer behavior;
- absence of host secret injection and arbitrary host mounts/path authority;
- host-only authoritative Git/publication/coordination/release/control state;
- real guest workloads required by the supported host/guest matrix;
- stop/restart persistence and explicit reset/reseed behavior;
- timeout/cancellation/process cleanup without deleting persistent disk state;
- recovery after daemon/host/guest interruption;
- candidate import/sealing under host authority;
- DB-019 evidence identity including host platform, provider, image, environment, bridge, and guest toolchain where material;
- absence of any direct-host repository-execution fallback or resurrected sandbox dependency.

`doctor` must distinguish requested configuration from observed provider/image/environment readiness.

Examples of insufficient evidence include:

- Hyper-V feature installed but unusable by DevBridge;
- `/dev/kvm` present but libvirt/provider access unusable;
- a configured VM/domain name with a missing/incompatible disk;
- a qcow2/VHDX path without verified parent/backing identity;
- a guest-agent socket that has not completed the bounded bridge health protocol.

## Resource governance

VM CPU, memory, disk, and lifecycle policy are local host authority. DB-018's process-priority behavior is not a repository-execution containment boundary and must not become a substitute during the no-provider interval.

Stage 7 must define truthful resource observations/limits for both Hyper-V and KVM/libvirt without pretending that unsupported quota semantics are enforced. Persistent environments also require bounded disk-growth/cleanup policy that never deletes unowned disks.

## Recovery and contamination

A repository VM is intentionally persistent, so compromise or bad tool state can persist. Persistence is a feature, not a trust claim.

The host must retain enough identity/evidence to decide whether to reuse, stop, quarantine, reset, or reseed an environment. A trusted operator/control-plane reset must be able to discard a contaminated writable layer and recreate the environment from an immutable base plus authoritative repository input.

Guest assertions that an environment is clean are not authority. Host-side identity, provider observation, bridge results, and verification decide reuse.

Provider-specific recovery must understand the actual storage chain: Hyper-V differencing parent/child relationships or QEMU qcow2 backing/overlay relationships. Reparent/rebase operations are never implicit migration shortcuts.

## Required initial providers

A complete first implementation supports both host families.

### Windows host provider

- Hyper-V is locally available/manageable by the trusted DevBridge service/account;
- immutable/versioned base VHD/VHDX images;
- persistent per-repository differencing disks where supported;
- persistent Windows and Linux guest profiles as locally provisioned/qualified;
- Stage-4-selected bridge transport(s) satisfying this contract.

### Linux host provider

- KVM acceleration is locally available and usable;
- QEMU VM execution is managed through a locally controlled libvirt system provider (normally `qemu:///system`) or an equivalently bounded provider adapter justified by Stage 2 research;
- immutable/versioned base images;
- persistent per-repository qcow2 overlays/backing chains where supported;
- persistent Linux and Windows guest profiles as locally provisioned/qualified;
- Stage-4-selected libvirt/QEMU bridge transport(s) satisfying this contract.

The provider-neutral ports represent common lifecycle, image, environment, bridge, and observed-readiness semantics. They must not erase meaningful provider differences or devolve into raw command-string passthrough.

## Legacy migration rule

The host sandbox was not retained until VM qualification. Stage 1 deliberately removed active Bubblewrap/AppContainer/ProcessContainer-style repository execution before production VM implementation.

The Stage-1 removal order was:

1. locate and classify the existing execution connection studs;
2. disable/remove legacy production provider registration;
3. establish explicit no-provider/fail-closed behavior;
4. repair abstraction leaks exposed by the unplug;
5. prove a test fake can attach through the resulting studs;
6. delete active legacy host-sandbox implementation/wiring while preserving generic behavior and historical evidence.

The remaining migration order is:

7. build Hyper-V/KVM-libvirt providers against the exposed provider-neutral boundary;
8. restore repository execution only through VMs in Stage 6.

`docs/vm-lego-studs.md` defines the replaceability proof. `docs/vm-migration.md` is the migration inventory. `docs/vm-stage1-connection-map.md` records the exact Stage-1 implementation boundary and evidence.

## Relationship to existing contracts

- DB-001: the control plane remains authoritative; VM provider/bridge adapters sit at the edge.
- DB-003: security/capability authority remains local; repository execution containment is this VM boundary, and provider absence fails closed.
- DB-008: authoritative Git/publication stays host-owned; dependency/build execution moves into the networked guest trust domain after restoration.
- DB-009: VM/bridge effects use durable observe/reconcile-before-repeat semantics; removed-provider effects reconcile rather than retrying unsafely.
- DB-011: candidate release identity/rollback remains; candidate-controlled execution is unavailable after host-boundary removal until VM isolation is restored.
- DB-013: controller plans remain data; repository-code operations execute through VM-backed adapters once available and do not fall back to host processes.
- DB-015: inventory never creates authority; guest tool discovery/onboarding remains untrusted observation.
- DB-016: coordination keys/lease authority remain host-only.
- DB-017: baseline/candidate identity remains host-authoritative across guest synchronization.
- DB-018: workstation governance remains local and must not be confused with containment.
- DB-019: verification cost/evidence remains control-plane authority and must bind host/provider/image/environment identities where relevant.

## Required implementation stages

Issue #107 defines the dependency order:

1. **Stage 1 — complete:** locate/prove execution studs, establish fail-closed no-provider behavior, and remove active legacy host-sandbox repository execution.
2. Stage 2 — Windows Hyper-V + Linux KVM/QEMU/libvirt host backends and immutable/versioned base-image lifecycle, attached to the provider-neutral Stage-1 boundary.
3. Stage 3 — persistent per-repository/per-OS writable-disk and VM lifecycle on both providers.
4. Stage 4 — narrow host↔guest command/file bridge, with provider-specific transport adapters behind the Stage-1 studs.
5. Stage 5 — guest bootstrap, networking, toolchain/development behavior.
6. Stage 6 — restore repository operations/workers/candidate execution through VMs only; no host-sandbox fallback.
7. Stage 7 — verification, doctor, recovery, CI, resource, security, and LEGO replaceability qualification across the supported provider/guest matrix.
8. Stage 8 — installer/setup/reconfiguration UX for Windows and Linux hosts, including deliberate migration of obsolete sandbox-era config.
9. Stage 9 — finalize one VM-only architecture and remove remaining migration/config/documentation scaffolding; the active sandbox runtime is already gone.

## Non-goals

DB-020 does not require a second sandbox inside the guest, default-deny guest networking, host credential passthrough, arbitrary shared host directories, a full duplicated base OS disk for every repository, hypervisors beyond the required Hyper-V and KVM/QEMU/libvirt providers in the first implementation, or implementation cleanup in Stage 0.

It also does not preserve temporary repository-code availability at the cost of maintaining the superseded sandbox architecture. During the intentional no-provider interval, capability reporting remains honest and repository execution fails closed.
