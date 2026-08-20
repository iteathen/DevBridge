# DevBridge roadmap

## Current checkpoint

DevBridge already has a substantial host control plane: exact GitHub provenance, managed authoritative Git/workspaces, durable runs/recovery, controller plans, tool inventory/onboarding, checkpoint-and-proceed decisions, multi-agent leases/fencing, baseline-drift reverification, supervised self-update, cooperative pause/resource priority, and the DB-019 verification-governance contract.

Repository-controlled execution is in an architectural transition.

- Current main has a verified Linux/Bubblewrap host sandbox for supported repository-code execution.
- Draft PR #106 contains experimental Windows ProcessContainer/AppContainer work.
- DB-020 now supersedes both mechanisms as the **target** architecture: persistent networked repository VMs, with the trusted DevBridge controller and all authoritative secrets/Git/publication state on the host.
- The old sandbox paths remain only until the VM replacement is implemented and qualified.

Do not extend Bubblewrap/AppContainer/ProcessContainer/Gitless host projection as the long-term solution unless an interim security fix is required to keep the currently live path safe.

## Active VM program — issue #107

The dependency order is authoritative. Each stage performs the project's planning/research gate before implementation and must not depend on a lower stage that has not landed.

### Stage 0 — architecture/spec ratification and migration inventory — #108

Goal: make the VM pivot normative before code implementation begins.

Deliverables:

- DB-020 persistent VM execution-boundary contract;
- DB-003/DB-008 and related active documentation aligned to the VM trust model;
- explicit network-on confidentiality implications;
- persistent repository+guest-OS environment lifetime/identity requirements;
- host-only authority/secrets enumeration;
- transport-neutral narrow bridge contract;
- Windows/Hyper-V initial provider target plus truthful future-provider abstraction;
- `docs/vm-migration.md` classification/removal map.

No runtime/config/CI cleanup belongs in this stage.

### Stage 1 — VM control-plane contracts and stable repository/OS identity — #109

Define provider-neutral but Hyper-V-grounded ports/state for:

- stable repository identity, preferring verified immutable GitHub repository ID over display name alone;
- guest OS/profile identity;
- base-image identity/generation;
- repository environment identity/generation;
- persistent child-disk identity;
- lifecycle/recovery states;
- bridge capability/readiness identity;
- reset/reseed/delete ownership semantics.

This stage defines contracts/state, not a speculative multi-hypervisor framework.

### Stage 2 — Hyper-V backend and immutable base-image lifecycle — #110

Implement the trusted Windows-host Hyper-V management adapter and versioned base-image lifecycle.

Prove:

- locally controlled Hyper-V discovery/readiness;
- immutable/versioned Windows and Linux guest base images;
- exact image identity and compatibility metadata;
- safe image creation/update/retention;
- no guest authority over hypervisor management;
- recovery from interrupted image lifecycle operations.

### Stage 3 — persistent per-repository/per-OS disk and VM lifecycle — #111

Implement repository environment materialization and persistence.

Where Hyper-V supports it, use per-repository differencing/child VHD/VHDX disks based on immutable parents.

Prove:

- one stable environment per repository identity + enabled guest OS/profile + generation;
- stop/shutdown retains disk/tool/build/repository state;
- host/daemon restart rediscover/reconcile rather than duplicate;
- parent/child chain integrity;
- explicit reset/reseed and owned deletion;
- no unowned VM/disk cleanup.

### Stage 4 — narrow host↔guest command/file bridge — #112

Research and select the concrete transport(s) for Windows and Linux guests.

The solution must preserve DB-020's transport-independent authority contract:

- exact environment/run/operation identity;
- bounded structured command input;
- bounded file/source transfer into guest;
- bounded result/candidate retrieval;
- timeout/cancellation/liveness;
- no arbitrary host-path naming;
- no credential/control-state/VM-management crossing;
- restart/recovery semantics.

PowerShell Direct, Hyper-V sockets/integration channels, network transports, or combinations may be considered; Stage 4 chooses based on actual platform behavior rather than convenience assumptions.

### Stage 5 — guest bootstrap, networking, toolchain, development environment — #113

Make persistent Windows/Linux guests useful for real development.

Target behavior:

- normal guest networking enabled by default;
- Node/CMake/CTest/native compiler/package-manager/browser/coding-tool workflows as needed by acceptance;
- guest-local tooling/caches survive VM stop/restart;
- no required Bubblewrap/AppContainer layer inside the guest;
- no host credentials or arbitrary writable host mounts;
- guest tool inventory/readiness can be observed through the bridge;
- base-image/tooling updates are versioned rather than mutating parents under existing children.

### Stage 6 — route deterministic operations, workers, and candidate execution through VMs — #114

Move repository-controlled execution off the trusted host.

Implement:

- controller-plan deterministic operation routing to the bound repository environment;
- proposal/coding-worker execution through the VM bridge;
- source synchronization into persistent guests;
- candidate/result import back to the host;
- host-authoritative Git/sealing/publication unchanged;
- dynamic `tool.*` probing/execution in the guest;
- package/build/test/browser repository execution in the guest;
- runtime candidate-controlled validation through an appropriate VM validation environment;
- exact drift/source/candidate identity checks;
- authenticated external-service/private-source support only through an explicit mechanism that does not copy broad host authority into persistent guests.

### Stage 7 — verification, doctor, recovery, CI, resources, security acceptance — #115

This is the replacement-acceptance gate.

Add real evidence for:

- Hyper-V/provider/base-image/environment/bridge readiness;
- Windows and Linux guest end-to-end workloads;
- root/admin-compromised guest cannot obtain host secrets, authoritative Git/publication state, daemon/coordination/release state, arbitrary host paths/mounts, or hypervisor authority;
- network-on guest confidentiality model;
- persistent disk survival across command/VM/daemon/host lifecycle tests where practical;
- bridge timeout/cancellation/recovery;
- reset/reseed contamination recovery;
- source/candidate import and host sealing;
- runtime candidate VM validation;
- DB-019 exact evidence identity and cost-aware qualification;
- truthful VM CPU/memory/disk/lifecycle/resource observations/limits;
- `doctor` distinguishes configuration from observed readiness;
- CI includes real Hyper-V VM-boundary qualification on appropriate runners/infrastructure.

Only after this stage provides replacement evidence can legacy sandbox removal be considered.

### Stage 8 — installer/setup/reconfiguration integration — #116

Integrate VM support into the installation/setup workflow coordinated with issue #103.

Setup should:

- discover host/platform/account/repository facts before prompting where safe;
- detect Hyper-V/provider readiness and explain required local operator actions;
- discover/suggest appropriate repositories/guest OS profiles/base images;
- require explicit operator approval before enabling recommended capabilities;
- support re-entering discovery/setup later to add/remove/change repositories, guest profiles, image policy, or execution capabilities;
- migrate/deprecate legacy sandbox config deliberately rather than silently rewriting local authority;
- keep execution disabled until the required VM provider/image/environment readiness is verified.

### Stage 9 — remove legacy host sandbox machinery and retire PR #106 — #117

After Stage 7 acceptance and Stage 8 deployability:

- remove Bubblewrap provider/probe/status and Bubblewrap/AppArmor CI setup no longer required;
- remove/refuse obsolete host `externalReadRoots` repository-execution semantics;
- remove ProcessContainer/AppContainer/MXC/native-helper experiments/remnants;
- remove Gitless host project-projection scaffolding;
- remove sandbox-specific host worker IPC bind/ACL projection;
- remove host-sandbox candidate validation;
- delete/rewrite obsolete sandbox tests/docs/config surfaces only after equivalent VM invariants are covered;
- retain generic process/result capture, deterministic operation registry, worker/result protocol semantics, authoritative Git/publication, recovery, supervision, leases, checkpoints, and verification evidence;
- close/retire draft PR #106 with a clear historical pointer rather than pretending its work never happened.

`docs/vm-migration.md` is the concrete removal/blocker inventory.

## Parallel active work

### DB-019 verification-cost/evidence implementation — #105

The DB-019 contract is active but its complete planner/evidence-store implementation remains separate work.

VM implementation should integrate with, not bypass, it:

- VM/provider/bridge/security changes can force qualification;
- exact environment/image/provider identities participate in evidence;
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
- stronger numeric repository/tool/profile identity evidence outside the VM-specific Stage-1 work;
- GitHub App installation authentication;
- general parallel task scheduling;
- default-branch merge/release/deployment as ordinary task effects.

## Engineering rules for roadmap work

For every VM stage:

1. read `AGENTS.md`, active specs, DB-020, the prerequisite VM stages, and `docs/vm-migration.md`;
2. inspect the implementation being replaced/extended;
3. research relevant Hyper-V/Windows/Linux APIs and failure semantics;
4. write a scoped plan covering ownership, state transitions, authority crossings, recovery, tests, migration, and expected files;
5. sanity-check against correctness/containment, persistence, recoverability, operator UX, performance, and DB-019 verification cost;
6. proceed when no genuine architecture/authority choice remains; checkpoint only high-leverage architectural decisions.

Preserve historical handoffs/audits rather than rewriting them to look current.
