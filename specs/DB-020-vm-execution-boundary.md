# DB-020 — Persistent VM Execution Boundary

Status: active architecture contract; implementation is staged by issues #107 through #117.

Implementation status: not yet cut over. Current main still contains the legacy Linux/Bubblewrap repository-code path, and draft PR #106 contains experimental Windows ProcessContainer/AppContainer work. Those mechanisms are temporary migration scaffolding, not the target architecture defined here.

## Goal

Make a persistent virtual machine the sole required security boundary for repository-controlled execution while keeping DevBridge's authoritative control plane, secrets, Git/publication authority, and recovery state on the trusted host.

The intended reference deployment is a Windows host using Hyper-V to run persistent Windows and Linux guest environments. DevBridge must keep the control contract provider-shaped so a future hypervisor backend can be added without changing the authority model, but this specification does not claim that any non-Hyper-V provider is implemented or qualified.

## Precedence

For repository-controlled execution, this specification supersedes earlier active documentation that treats Bubblewrap, AppContainer, ProcessContainer, host path allowlists, Gitless host projections, or another host-process sandbox as the target security boundary.

Earlier DB-003, DB-008, DB-011, DB-013, DB-015, setup/bootstrap, tool-profile, and roadmap descriptions remain useful where they describe current transitional behavior or provider-independent invariants. Where they conflict with this contract's target repository-execution architecture, DB-020 governs.

Historical handoffs, audits, and PR #106 remain historical engineering evidence. They do not regain normative authority merely because their mechanisms still exist during migration.

## Core rule

**Repository-controlled code executes in an untrusted VM. The host controller assumes that VM may be fully compromised and therefore gives it no host authority worth protecting.**

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

## Terminology

- **trusted host** — the machine/OS context in which the DevBridge controller and hypervisor-management adapter hold local authority.
- **repository environment** — one persistent execution environment bound to one authoritative repository identity plus one enabled guest OS/profile identity.
- **guest** — the VM OS and all software/state inside a repository environment. The guest is untrusted.
- **base image** — an immutable/versioned OS+bootstrap/tooling disk identity from which repository environments are derived.
- **child disk** — the persistent per-repository/per-OS writable disk layered on an immutable base image where the provider supports differencing/copy-on-write disks.
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

### Guest-owned disposable state

A repository environment may persist ordinary development state such as:

- source working bytes supplied by the host;
- build trees, dependency caches, package installations, SDK/tool installations permitted by guest policy;
- guest-local configuration that contains no host secret;
- test/browser artifacts;
- guest Git metadata and local branches/remotes that are not authoritative publication state;
- coding-worker scratch/results that will later cross the bridge as untrusted data.

Persistence does not convert guest state into authority.

## Threat model

The security design must remain correct if repository-controlled execution obtains administrator/root in the guest, replaces guest tools, tampers with guest Git, modifies guest startup/services, persists across reboots, controls every guest-local file, and uses normal network access to exfiltrate anything present in the guest.

Therefore confidentiality is achieved primarily by **not placing host secrets in the guest**, not by assuming guest egress filtering will contain a compromised process.

Hypervisor escape, host kernel compromise, firmware compromise, or a defect in the selected hypervisor security boundary is outside DevBridge's software-only containment claim. Provider qualification must nevertheless use supported host/hypervisor configurations and treat unsafe/unknown capability state as unavailable.

## Persistent repository/OS identity

A repository environment is persistent per stable repository identity and enabled guest OS/profile. Human-readable `owner/name` remains useful routing metadata but must not be the sole durable environment identity because repositories can be renamed or transferred. Stage 1 defines the exact repository identity contract and should prefer the immutable GitHub numeric repository ID when available and verified.

The durable environment identity must also bind at least:

- guest OS/profile identity;
- base-image identity/version/generation;
- environment generation;
- child-disk identity;
- relevant provider identity;
- lifecycle/recovery state.

Changing a display name does not silently create a second environment. Changing a security- or compatibility-relevant image/profile identity does not silently reuse incompatible state.

## Base images and child disks

Base OS/tooling images are immutable and versioned. A repository environment must not mutate its parent/base image in place.

Where Hyper-V/provider semantics support it, each repository environment uses a writable child/differencing disk whose parent is an exact immutable base disk. The child disk persists repository-specific OS/tool/build state while amortizing the base installation across repositories.

The controller must track the exact parent/child relationship and fail closed on an unexplained or incompatible chain. Base-image updates create a new image identity; they do not rewrite the parent beneath existing children without an explicit migration/reseed procedure.

A future provider may use another copy-on-write/clone primitive or, if necessary, a dedicated full disk, but it must preserve the same isolation, identity, immutability, and recovery semantics.

## Lifecycle and persistence

Process lifetime, VM runtime lifetime, and repository-disk lifetime are separate concepts.

- Completing, timing out, or cancelling one command must not delete the repository environment.
- Stopping or shutting down the VM must retain its persistent child disk.
- Host/daemon restart must be able to rediscover and reconcile the existing environment rather than silently provisioning a second one.
- A crashed/unreachable VM is an infrastructure/recovery condition, not permission to discard state.
- Reset/reseed is an explicit control-plane action that discards an environment generation and reconstructs it from a trusted base plus authoritative source inputs.
- Deletion is ownership-bound and must never be inferred from a guest request or an ambiguous hypervisor observation.

DB-009's observe/reconcile-before-repeat rule applies to VM create/start/stop/reset/reseed/delete and bridge effects where ambiguity can exist.

## Guest networking

Repository guests have normal network connectivity by default.

This is deliberate. Development environments routinely need package registries, SDK installers, documentation, source fetches, test endpoints, browser access, and coding-service traffic. DevBridge must not make a custom deny-by-default egress proxy a prerequisite for normal repository execution.

Because guest egress is normally available:

- any secret placed in the guest must be assumed exfiltratable;
- host GitHub, coordination, release/signing, daemon, and VM-management secrets must never be injected for convenience;
- network availability is not evidence that a guest has host authority;
- disabling guest networking may exist as an optional workload/policy mode, but it is not the normal security basis.

Private-source and authenticated-service workflows must use later explicit mechanisms that preserve the host-only authority rule. Stage 6 owns the exact coding/model-adapter topology and any scoped credential relay design; this spec does not authorize copying host tokens into guests.

## Narrow host↔guest bridge

DevBridge operates guests through a narrow host-controlled bridge rather than arbitrary shared host directories.

The bridge contract must support the minimum required classes of exchange:

- start a locally admitted guest command/operation;
- pass bounded structured input/context;
- transfer bounded files or source snapshots into the guest;
- retrieve bounded result/evidence/candidate files from the guest;
- observe command exit, timeout/cancellation, and bounded output/liveness;
- identify the exact repository environment and operation/run subject.

The bridge must not allow guest-controlled input to name arbitrary host filesystem paths, host executables, Git refs, credential locations, VM-management targets, or control-state objects. Host paths remain host-local implementation details; bridge messages use bounded logical identities/relative guest paths/opaque transfer objects.

The transport is intentionally not selected by Stage 0. Hyper-V offers multiple relevant mechanisms, including host/guest integration channels and Windows-specific PowerShell Direct; Stage 4 must research and select the transport(s) against Windows and Linux guest requirements, authentication/identity, framing, cancellation, binary transfer, recovery, and testability. The authority contract above must remain transport-independent.

The bridge itself is not publication authority. Guest output is untrusted until the host validates it under the owning protocol.

## Source, candidate, and Git model

Authoritative Git remains host-owned.

A normal repository workflow is conceptually:

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

After Stage 6 cutover, repository-controlled execution classes must use the repository VM boundary. This includes, as applicable:

- deterministic build/test/tool operations that execute repository-controlled code/config/plugins;
- proposal/coding-worker command execution;
- package-manager and dependency lifecycle execution;
- browser/integration tooling driven by repository content;
- generated/local-manifest `tool.*` wrappers whose execution class is repository-controlled;
- repository-specific compiler/build/test invocations;
- DevBridge candidate-controlled validation where the candidate itself is untrusted executable code, using an appropriate VM environment rather than host sandboxing.

Pure control-plane parsing, cryptographic verification, GitHub API operations, authoritative Git operations, VM management, deterministic transformations that provably do not execute repository-controlled code, and other trusted static adapters may remain on the host.

The classification decision remains DevBridge-owned. A repository cannot label its own executable operation "safe host".

## Tooling and development environment behavior

Persistent VMs replace the target use of `workspace.externalReadRoots`, host PATH exposure, and sandbox-specific filesystem grants for repository execution. Repository tools should be installed or discovered inside the guest environment, where their presence and state can persist for that repository/OS.

Host-side tool inventory remains useful for control-plane tools and hypervisor/bootstrap prerequisites. Guest tool inventory is untrusted observation used for planning and verification, not authority to run arbitrary host commands.

DB-015 automatic onboarding must ultimately probe and execute repository-class tools in the guest. Its safe schema/manifest/projection rules remain reusable.

## Runtime candidate validation

DevBridge self-update candidates are untrusted until accepted. The legacy candidate validator currently relies on the host OS sandbox. The target architecture routes candidate-controlled execution through a VM boundary while retaining DB-011's exact release-subject, artifact-digest, last-known-good, activation, and rollback rules.

A runtime candidate environment does not need the same long-lived per-repository persistence semantics as ordinary project environments; Stage 6 may use a dedicated/reseedable VM workflow as long as candidate code receives no host control authority and the exact accepted artifact is still the exact activated artifact.

## Verification and `doctor`

Configuration declarations do not prove VM isolation.

Before DevBridge reports repository-code execution usable, Stage 7 must establish observed evidence for at least:

- provider/hypervisor availability and supported host configuration;
- exact base-image identity and parent/child disk integrity;
- exact repository-environment identity and lifecycle reconciliation;
- bridge identity/framing and bounded transfer behavior;
- absence of host secret injection and arbitrary host mounts/path authority;
- host-only authoritative Git/publication/coordination/release/control state;
- real Windows and Linux guest workloads required by the program;
- stop/restart persistence and explicit reset/reseed behavior;
- timeout/cancellation/process cleanup without deleting persistent disk state;
- recovery after daemon/host/guest interruption;
- candidate import/sealing under host authority;
- DB-019 evidence identity including provider/image/environment where material.

`doctor` must distinguish requested configuration from observed provider/image/environment readiness. Presence of Hyper-V, a VM name, or a configured image path alone is not verification evidence.

## Resource governance

VM CPU, memory, disk, and lifecycle policy are local host authority. DB-018's current process-priority behavior remains a transitional host-process QoS mechanism and is not the VM security boundary.

Stage 7 must define truthful resource observations/limits for the Hyper-V provider without pretending that unsupported quota semantics are enforced. Persistent environments also require bounded disk-growth/cleanup policy that never deletes unowned disks.

## Recovery and contamination

A repository VM is intentionally persistent, so compromise or bad tool state can persist. Persistence is a feature, not a trust claim.

The host must retain enough identity/evidence to decide whether to reuse, stop, quarantine, reset, or reseed an environment. A trusted operator/control-plane reset must be able to discard a contaminated child disk and recreate the environment from an immutable base plus authoritative repository input.

Guest assertions that an environment is clean are not authority. Host-side identity, bridge results, and verification decide reuse.

## Initial provider and future abstraction

The first deployment target is:

- Windows host;
- Hyper-V enabled and locally manageable by the trusted DevBridge host service/account;
- persistent Windows guest environment support;
- persistent Linux guest environment support;
- immutable/versioned Hyper-V base VHD/VHDX images;
- per-repository child/differencing disks where supported;
- one or more Stage-4-selected host↔guest bridge transports that satisfy this contract.

Provider-neutral ports should represent lifecycle, image, environment, bridge, and observed-readiness semantics. Do not add abstraction merely to claim portability; the first implementation must prove Hyper-V behavior before another backend is promised.

## Legacy migration rule

Until Stage 7 proves replacement acceptance and Stage 8 makes setup usable, existing host sandbox code may remain enabled only as transitional compatibility/scaffolding for already-supported paths. It must not be extended as the architectural answer to the VM program unless a security fix is required to keep the interim path from becoming less safe.

Stage 9 owns deletion/retirement after replacement evidence exists. `docs/vm-migration.md` is the concrete removal inventory and blocker map.

## Relationship to existing contracts

- DB-001: the control plane remains authoritative; VM provider/bridge adapters sit at the edge.
- DB-003: security/capability authority remains local; repository execution containment is now this VM boundary.
- DB-008: authoritative Git/publication stays host-owned; dependency/build execution moves into the networked guest trust domain.
- DB-009: VM/bridge effects use durable observe/reconcile-before-repeat semantics.
- DB-011: candidate release identity/rollback remains; candidate-controlled execution migrates to VM isolation.
- DB-013: controller plans remain data; repository-code operations execute through VM-backed adapters rather than host sandbox providers.
- DB-015: inventory never creates authority; guest tool discovery/onboarding remains untrusted observation.
- DB-016: coordination keys/lease authority remain host-only.
- DB-017: baseline/candidate identity remains host-authoritative across guest synchronization.
- DB-018: workstation governance remains local and must not be confused with containment.
- DB-019: verification cost/evidence remains control-plane authority and must bind VM/provider/image/environment identities where relevant.

## Required implementation stages

Issue #107 defines the dependency order. This contract is intentionally broad enough that later stages do not need to reconstruct the architectural pivot:

1. Stage 1 — VM contracts and stable repository/OS identity.
2. Stage 2 — Hyper-V host backend and immutable base-image lifecycle.
3. Stage 3 — persistent per-repository/per-OS child-disk and VM lifecycle.
4. Stage 4 — narrow host↔guest command/file bridge.
5. Stage 5 — guest bootstrap, networking, toolchain/development behavior.
6. Stage 6 — route repository operations/workers/candidate execution through VMs.
7. Stage 7 — verification, doctor, recovery, CI, resource, and security qualification.
8. Stage 8 — installer/setup/reconfiguration UX.
9. Stage 9 — remove superseded host sandbox machinery and retire draft PR #106.

## Non-goals

DB-020 does not require a second sandbox inside the guest, default-deny guest networking, host credential passthrough, arbitrary shared host directories, a full duplicated base OS disk for every repository, immediate multi-hypervisor support, or implementation cleanup in Stage 0.

It also does not claim that the current main branch already satisfies this target. Until the later stages land, capability reporting must remain honest about the transitional implementation.
