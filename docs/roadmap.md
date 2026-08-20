# DevBridge roadmap

## Current checkpoint

DevBridge already has a substantial host control plane: exact GitHub provenance, managed authoritative Git/workspaces, durable runs/recovery, controller plans, tool inventory/onboarding, checkpoint-and-proceed decisions, multi-agent leases/fencing, baseline-drift reverification, supervised self-update, cooperative pause/resource priority, and the DB-019 verification-governance contract.

Repository-controlled execution is in an architectural transition.

- Current main has a verified Linux/Bubblewrap host sandbox for supported repository-code execution.
- Draft PR #106 contains experimental Windows ProcessContainer/AppContainer work.
- DB-020 supersedes both as the **target** architecture: persistent networked repository VMs, with trusted DevBridge controller/authority on the host.
- The required initial host providers are Windows/Hyper-V and Linux/KVM-QEMU-libvirt.
- The old sandbox paths remain only until the VM replacement is implemented, qualified, and installable without dropping either supported host family.

Do not extend Bubblewrap/AppContainer/ProcessContainer/Gitless host projection as the long-term solution unless an interim security fix is required to keep the currently live path safe.

## Active VM program — issue #107

The dependency order is authoritative. Each stage performs the project's planning/research gate before implementation and must not depend on a lower stage that has not landed.

### Stage 0 — architecture/spec ratification and migration inventory — #108

Goal: make the VM pivot normative before code implementation begins.

Deliverables:

- DB-020 persistent VM execution-boundary contract;
- Windows/Hyper-V and Linux/KVM-QEMU-libvirt named as coequal first-class provider targets;
- DB-003/DB-008 and related active documentation aligned to the VM trust model;
- explicit network-on confidentiality implications;
- persistent repository+provider+guest-OS environment lifetime/identity requirements;
- provider-native storage model: VHDX differencing and qcow2 backing/overlays;
- host-only authority/secrets enumeration;
- transport-neutral narrow bridge contract with provider-specific adapters;
- `docs/vm-migration.md` classification/removal map.

No runtime/config/CI cleanup belongs in this stage.

### Stage 1 — VM control-plane contracts and stable provider/repository/OS identity — #109

Define one typed model for:

- provider identity;
- stable repository identity, preferring verified immutable GitHub repository ID over display name alone;
- guest OS/profile identity;
- base-image identity/generation;
- repository environment identity/generation;
- persistent writable-layer identity;
- lifecycle/recovery states;
- bridge capability/readiness identity;
- reset/reseed/delete ownership semantics.

The contract must support Hyper-V and KVM/libvirt without a fake lowest-common-denominator model and without raw provider command passthrough.

### Stage 2 — Windows Hyper-V + Linux KVM/QEMU/libvirt backends and immutable base-image lifecycle — #110

Implement both required host providers.

Windows:

- observed Hyper-V capability/management readiness;
- immutable/versioned Windows/Linux guest VHD/VHDX base images;
- provider networking and provider-owned object lifecycle.

Linux:

- observed KVM acceleration + libvirt/QEMU readiness;
- normally locally authorized `qemu:///system` management or a justified narrower equivalent;
- immutable/versioned Windows/Linux guest base images;
- qcow2 base/backing identity;
- provider networking/storage lifecycle.

Both providers must expose truthful readiness and keep raw VM/domain/image/command authority local.

### Stage 3 — persistent per-repository/per-OS writable layers and VM lifecycle — #111

Implement repository environment persistence on both providers.

- Hyper-V: per-repository differencing VHD/VHDX where supported.
- KVM/QEMU: per-repository qcow2 overlays/backing chains where supported.

Prove stable environment identity, stop/start persistence, daemon/provider restart reconciliation, explicit reset/reseed, disk-chain integrity, concurrency control, and owned cleanup without silent reparent/rebase.

### Stage 4 — provider-adapted host↔guest command/file bridge — #112

Research/select concrete transports while preserving one typed host-controlled bridge contract.

Hyper-V candidates include integration channels/sockets and Windows-specific PowerShell Direct where appropriate.

KVM/libvirt candidates include QEMU Guest Agent/virtio-serial/vsock and libvirt channel APIs. QEMU Guest Agent is guest-controlled/untrusted response data, not a security oracle.

The bridge must provide exact environment/run/operation identity, bounded exec/input/output/file transfer, timeout/cancellation/liveness, no arbitrary host-path naming, no control credentials, and restart/recovery semantics.

### Stage 5 — guest bootstrap, networking, toolchain, development environment — #113

Make persistent Windows/Linux guests useful for real development on both provider families.

Target behavior:

- normal guest networking enabled by default;
- Node/CMake/CTest/native compiler/package-manager/browser/coding-tool workflows as needed by acceptance;
- guest-local tooling/caches survive VM stop/restart;
- no required Bubblewrap/AppContainer layer inside the guest;
- no host credentials or arbitrary writable host mounts;
- guest tool inventory/readiness observed through the bridge;
- base-image/tooling updates versioned instead of mutating parents/backings beneath existing repository state.

### Stage 6 — route deterministic operations, workers, and candidate execution through VMs — #114

Move repository-controlled execution off the trusted host.

Implement:

- controller-plan deterministic operation routing to exact repository environments;
- proposal/coding-worker execution through the VM bridge;
- source synchronization into persistent guests;
- candidate/result import back to the host;
- host-authoritative Git/sealing/publication unchanged;
- dynamic `tool.*` probing/execution in the guest;
- package/build/test/browser repository execution in the guest;
- runtime candidate-controlled validation through a provider-native VM validation environment;
- exact drift/source/candidate identity checks;
- authenticated external-service/private-source support only through explicit mechanisms that do not copy broad host authority into persistent guests.

### Stage 7 — provider/guest matrix verification, doctor, recovery, CI, resources, security acceptance — #115

This is the replacement-acceptance gate.

Add real evidence for both host providers:

- Hyper-V provider/base-image/environment/bridge readiness;
- KVM/QEMU/libvirt provider/base-image/environment/bridge readiness;
- Windows/Linux guest workloads for every host/guest combination claimed supported;
- root/admin-compromised guest cannot obtain host secrets, authoritative Git/publication state, daemon/coordination/release state, arbitrary host paths/mounts, or provider-management authority;
- hostile/forged guest-agent/helper responses fail closed;
- network-on guest confidentiality model;
- VHDX parent/child and qcow2 backing/overlay identity;
- persistent state, reset/reseed, timeout/cancellation, restart/recovery;
- source/candidate import and host sealing;
- runtime candidate VM validation;
- DB-019 exact evidence identity and cost-aware qualification;
- truthful provider-specific resource policy;
- `doctor` distinguishes configuration from observed readiness.

Real virtualization qualification may require self-hosted/dedicated virtualization-capable runners. Do not replace real provider evidence with mocks because hosted CI lacks nested virtualization.

### Stage 8 — Windows/Linux installer/setup/reconfiguration integration — #116

Coordinate with issue #103.

Setup should discover before prompting:

Windows:

- Hyper-V availability/privilege/image/environment state.

Linux:

- KVM acceleration, QEMU/libvirt service/provider/access, image/environment state.

Both:

- approved repositories and immutable repo IDs;
- guest profiles/images;
- storage implications;
- bridge/bootstrap readiness;
- resource defaults;
- explicit prerequisites requiring elevation/reboot/package/service/group/session changes.

Setup must suggest safe defaults, require explicit consent for authority-bearing changes, support re-entry for repair/reseed/migration, and deliberately migrate/deprecate legacy sandbox config instead of silently reinterpreting it.

### Stage 9 — remove legacy host sandbox machinery and retire PR #106 — #117

Full retirement is hard-gated on applicable Stage-7/8 completion for **both** required host providers.

After that:

- remove Bubblewrap provider/probe/status and obsolete Bubblewrap/AppArmor qualification;
- remove/refuse obsolete host `externalReadRoots` repository-execution semantics;
- remove ProcessContainer/AppContainer/MXC/native-helper experiments/remnants;
- remove Gitless host project-projection scaffolding;
- remove sandbox-specific host worker IPC bind/ACL projection;
- remove host-sandbox candidate validation;
- delete/rewrite obsolete sandbox tests/docs/config only after equivalent VM invariants exist;
- retain generic process/result capture, deterministic operation registry, worker/result protocol semantics, authoritative Git/publication, recovery, supervision, leases, checkpoints, and verification evidence;
- close/retire draft PR #106 with historical pointers.

Stage 9 must not remove Bubblewrap and thereby make Linux hosts unsupported before KVM/libvirt is qualified/installable.

`docs/vm-migration.md` is the concrete removal/blocker inventory.

## Parallel active work

### DB-019 verification-cost/evidence implementation — #105

VM work integrates with DB-019:

- provider/bridge/security changes can force qualification;
- exact host platform/provider/image/environment/bridge identities participate in evidence;
- long VM suites need liveness and suite-specific timing;
- exact still-valid VM qualification should not be repeated merely because chat/daemon context rolled over.

### Setup/reconfiguration UX — #103

Issue #103 governs broader installation discovery/re-entry behavior. VM Stage 8 coordinates with it rather than creating a second unrelated setup wizard.

### Remaining #49 work

Issue #107 supersedes #49's repository-code sandbox-provider direction only.

Unrelated #49 surfaces such as per-installation dispatch/addressing, CLI/product ergonomics, and future truthful resource governance remain separate unless a later issue explicitly moves them.

## Other known boundaries

These remain intentionally incomplete unless covered by the VM stages above:

- complete generic remote-effect journaling/correlation for every future GitHub mutation;
- per-installation human-to-workstation task addressing for shared team queues;
- stronger numeric repository/tool/profile identity evidence outside Stage 1;
- GitHub App installation authentication;
- general parallel task scheduling;
- default-branch merge/release/deployment as ordinary task effects.

## Engineering rules for roadmap work

For every VM stage:

1. read `AGENTS.md`, active specs, DB-020, prerequisite VM stages, and `docs/vm-migration.md`;
2. inspect the implementation being replaced/extended;
3. research the relevant Hyper-V and/or KVM/QEMU/libvirt platform behavior and failure semantics;
4. write a scoped plan covering ownership, state transitions, authority crossings, recovery, tests, provider parity, migration, and expected files;
5. sanity-check against correctness/containment, persistence, recoverability, operator UX, performance, and DB-019 verification cost;
6. proceed when no genuine architecture/authority choice remains; checkpoint only high-leverage architectural decisions.

Preserve historical handoffs/audits rather than rewriting them to look current.
