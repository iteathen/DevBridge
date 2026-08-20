# VM migration and legacy-sandbox removal inventory

Status: active migration map for DB-020 / issue #107.

This document records what the VM program replaces, what remains valuable, and the new migration order.

## Governing rule

DB-020 is the target repository-execution architecture.

Required initial host providers:

- Windows -> Hyper-V;
- Linux -> KVM/QEMU managed through libvirt.

The migration now deliberately removes active host-sandbox repository execution **before** production VM implementation. The temporary gap is intentional:

- repository-controlled execution is unavailable and fail-closed;
- no direct/uncontained host fallback is allowed;
- trusted static/control-plane work may continue only where independently classified safe;
- VM execution is restored later through the same exposed LEGO studs.

This is an architectural test. If DevBridge cannot remain structurally coherent with no production repository execution provider registered, the coupling must be repaired before Hyper-V/KVM work proceeds.

Historical handoffs, commits, PR #106 discussion, tests, and failed experiments remain evidence and are not erased.

## Stage-0 planning conclusions

The target architecture fixes these invariants:

- host control plane and authoritative Git/publication remain trusted and host-only;
- repository guests are untrusted even at administrator/root;
- repository guests are persistent per stable repository identity + host provider + guest OS/profile;
- Windows hosts use Hyper-V;
- Linux hosts use KVM/QEMU through libvirt;
- immutable/versioned base images feed persistent provider-native copy-on-write state:
  - Hyper-V differencing VHD/VHDX;
  - qcow2 backing/overlay chains;
- guest networking is normally enabled;
- no host secrets or arbitrary writable host mounts are exposed to guests;
- host↔guest command/file interaction is narrow and host-controlled;
- no AppContainer/Bubblewrap layer is required inside the VM;
- bridge/controller contracts are provider-neutral without pretending Hyper-V and libvirt expose identical raw state;
- the old host sandbox is removed first rather than retained as a live fallback during VM construction.

Stage ownership:

- Stage 1 — expose/prove studs, establish no-provider fail-closed behavior, remove active sandbox execution;
- Stage 2 — Hyper-V/KVM-libvirt provider capability + immutable base images;
- Stage 3 — persistent repository VM lifecycle/storage;
- Stage 4 — host↔guest bridge;
- Stage 5 — guest bootstrap/network/tooling;
- Stage 6 — restore repository-controlled execution through VMs only;
- Stage 7 — real provider/security/recovery/replaceability qualification;
- Stage 8 — installation/reconfiguration/migration UX;
- Stage 9 — remove remaining migration/config/documentation scaffolding and finalize VM-only architecture.

## Researched provider primitives

### Hyper-V

Relevant platform primitives include:

- VHD/VHDX differencing disks for immutable-parent/persistent-child storage;
- Hyper-V VM lifecycle/networking APIs;
- PowerShell Direct for Windows guests where appropriate;
- Hyper-V sockets/VMBus/integration channels for host↔guest communication.

### KVM/QEMU/libvirt

Relevant platform primitives include:

- KVM as the Linux kernel virtualization API/accelerator;
- libvirt `qemu:///system` as the normal system-level QEMU/KVM management provider when local deployment policy grants access;
- qcow2 backing-file/overlay chains for immutable-parent/persistent-child storage;
- libvirt channel APIs;
- QEMU Guest Agent over virtio-serial or vsock-capable transport for guest operations.

QEMU Guest Agent is guest-controlled and may produce forged/spurious responses under a hostile guest. It is a transport candidate, not an authority source.

## Category 1 — remove in Stage 1 before VM implementation

### Linux Bubblewrap repository-execution provider

Current-main removal targets include:

- `src/runtime/bubblewrap-sandbox.js`;
- `src/runtime/bubblewrap-probe.js`;
- Bubblewrap-specific status constructors/fields in `src/runtime/sandbox-status.js`;
- Bubblewrap selection/normalization in `src/runtime/deterministic-sandbox.js`;
- Bubblewrap-specific branches in process/deterministic runners;
- Bubblewrap/AppArmor qualification/setup paths whose sole purpose is host repository execution;
- Bubblewrap-specific filesystem/network policy and tests that do not express generic retained invariants.

**Stage-1 rule:** remove provider registration first, prove fail-closed no-provider behavior, repair leaked dependencies, then delete the active provider implementation. Do not wait for KVM/libvirt replacement because the migration explicitly accepts temporary repository-execution unavailability.

### Windows ProcessContainer/AppContainer/MXC work

Draft PR #106 is historical/superseded implementation evidence, not a live migration dependency.

Files/families have included:

- `src/runtime/windows-processcontainer-sandbox.js`;
- `src/runtime/windows-processcontainer-compat-provider.js`;
- `src/runtime/windows-job-launcher.cs`;
- `src/runtime/windows-job-wrapper.ps1`;
- `src/bootstrap/windows-sandbox-runtime.mjs`;
- Windows sandbox provisioning/qualification code and tests.

Do not merge or revive these merely to preserve a fallback. Any equivalent remnants already present on the active implementation head are Stage-1 deletion candidates. PR #106 may be retired when the Stage-1 removal is implemented; its history remains available.

### Host-filesystem sandbox policy

Active repository-execution semantics to remove/disable in Stage 1 include:

- exposing host `workspace.externalReadRoots` to repository processes;
- host project write + subtractive `.git` protection as the execution-isolation model;
- host `/usr`, `/bin`, `/lib*`, SDK/toolchain read-root construction for repository workloads;
- synthetic host HOME/TMP mounts used to hide operator state from repository processes;
- host namespace network `deny`/`unrestricted` as the primary repository-execution security model;
- sandbox-specific outside-read/write/network probes;
- any `allowUncontainedTools` or compatibility path that could turn provider absence into direct host execution.

Configuration keys may remain temporarily recognized for migration/error reporting if needed, but they must not retain authority to execute repository code on the host.

### Sandbox-specific worker IPC mount/ACL plumbing

Remove host bind/ACL/mount transport that exists only to carry worker exchange through a host sandbox. Preserve the logical run/turn/result protocol, bounded parsing, identity binding, and recovery semantics.

During the no-provider interval those logical protocols may be dormant for repository execution; Stage 4/6 reconnect them through VM transfer/result studs.

### Host-sandbox candidate-controlled validation

Any self-update/candidate validation that executes untrusted candidate code through the host sandbox must become unavailable/fail-closed when Stage 1 removes the sandbox. Preserve DB-011 release identity, artifact identity, last-known-good, activation and rollback rules. VM candidate execution is restored later through Stage 6.

## Category 2 — retain/refactor as generic LEGO structure

### Generic process/result behavior

Retain provider-independent behavior such as:

- bounded stdout/stderr capture;
- timeout/cancellation;
- result parsing/failure classification;
- host helper lifecycle where still needed for trusted/provider processes.

Do not retain an assumption that a generic runner must always resolve to a host `spawn()` of repository code. The no-provider state is a valid execution-provider outcome.

### Deterministic operation registry/classification

Retain:

- closed operation schemas;
- local executable/operation authority;
- fail-closed classification of unknown/dynamic operations as repository-controlled.

During Stages 1–5, repository-controlled classes fail unavailable rather than executing directly on the host.

### Worker/result protocols

Retain semantic invariants from `devbridge/worker-exchange-v1`, `devbridge/result-v1`, run/turn/context digest binding, bounded results, and control-owned consumption/recovery.

Transport/mount details are replaceable; protocol meaning is not.

### Controller plans and proposal semantics

Retain DB-013 invariants:

- plans are data, not shell authority;
- executable/argv/environment/path/provider authority stays local;
- project proposals are not accepted Git state until host validation/sealing;
- cleanup/assertions/context receipts and deterministic schemas remain controller-owned.

### Authoritative Git/publication

Retain intact:

- host-managed canonical repository identity/baseline resolution;
- DB-017 publication baseline/candidate identity;
- host staging/sealing/commit creation;
- expected remote-head CAS/reconciliation;
- host-only GitHub/SSH publication credentials;
- publication/merge/release authority.

The no-provider interval must not move Git authority into an execution implementation.

### Recovery, leases, checkpoints, verification, supervision

Retain DB-009/007/016/018/019, DB-011 release identity/rollback, and runtime supervision. Provider absence and removal of an in-flight legacy effect must reconcile explicitly rather than being retried through an unsafe fallback.

### Tool inventory/onboarding

Retain DB-015 observation-vs-authority, manifest/schema validation, bounded help parsing, secret-safe projection, and operation registration.

Repository-class tool execution is unavailable after Stage 1 until Stage 6 routes it to guests. Host inventory remains for trusted control-plane/provider prerequisites.

## Category 3 — historical evidence

Preserve, do not rewrite as current architecture:

- handoffs/checksums on PR #106;
- older sandbox/security testing reports under `docs/testing/`;
- Git history;
- PR #106 discussion;
- CI runs;
- failed/superseded sandbox experiments.

Useful lessons remain:

- configured provider presence is not enforcement evidence;
- operation-tree ownership/cancellation matters;
- writable result transport needs identity/replacement defenses;
- authoritative Git must remain outside untrusted execution;
- a failed integration disproves that implementation, not necessarily the underlying OS primitive;
- cross-platform path/identity semantics must be explicit;
- guest agents/helpers are untrusted when the guest is compromised.

## Category 4 — deferred compatibility cleanup after VM restoration

These items need not remain active execution mechanisms but may remain as migration/error-recognition surfaces until Stage 8/9:

| Legacy family | Stage-1 behavior | Final cleanup owner |
| --- | --- | --- |
| `workspace.externalReadRoots` repository semantics | execution authority removed/ignored or rejected; no host execution | Stage 8/9 migration/schema cleanup |
| `execution.allowUncontainedTools` | must not bypass no-provider fail-closed state | Stage 1 removes unsafe effect; Stage 8/9 removes/deprecates key |
| sandbox profile fields | no longer authorize host repository execution | Stage 8/9 migration/schema/help cleanup |
| Bubblewrap/AppContainer qualification CI | active provider qualification removed | Stage 1 replaces with no-provider/LEGO tests; Stage 7 adds real VM qualification |
| sandbox-specific docs/status terminology | mark obsolete/no-provider state truthfully | Stage 9 final wording cleanup |
| historical PR/handoffs/testing evidence | preserve | never delete merely for architectural tidiness |

## Concrete current-main ownership map for Stage 1

### Remove/refactor from active repository execution

- `src/runtime/bubblewrap-sandbox.js`;
- `src/runtime/bubblewrap-probe.js`;
- `src/runtime/deterministic-sandbox.js` provider selection/factory;
- sandbox-specific status vocabulary in `src/runtime/sandbox-status.js`;
- sandbox-specific branches in `src/runtime/process-runner.js`;
- sandbox-specific branches in `src/runtime/deterministic-process-runner.js`;
- sandbox-dependent candidate execution in `src/bootstrap/candidate-validator.mjs`;
- host filesystem/network projection machinery used only to make sandboxed repository execution possible;
- active CI/bootstrap/setup wiring used only for legacy sandbox readiness.

The exact Stage-1 code-head audit is authoritative; this list is a starting inventory.

### Retain/refactor control-plane infrastructure

- generic portions of process/deterministic runners;
- `src/runtime/deterministic-operation-registry.js`;
- logical portions of `src/runtime/worker-exchange.js`;
- host-owned helper lifecycle utilities;
- runtime state/recovery/coordinator/Git/publication modules;
- DB-007/009/016/017/018/019 enforcement/evidence paths;
- bootstrap release-integrity and supervisor activation/rollback logic.

### Required no-provider behavior

Stage 1 must add or expose a provider-neutral unavailable state equivalent to:

- no production repository execution provider registered;
- repository-controlled execution rejected before host spawn;
- no direct/uncontained compatibility fallback;
- structured status/error distinguishing `provider unavailable` from guest command failure;
- `doctor`/CLI/setup truthfully report repository execution unavailable;
- generic controller/Git/recovery/verification modules remain usable where they do not require repository execution;
- tests prove repository code cannot reach host execution merely because no provider is installed.

The exact symbol/name may differ; behavior is normative.

## CI/test migration

Stage 1 replaces legacy live-sandbox qualification as an active requirement with cheap architectural/no-provider evidence:

1. generic unit/control-plane tests with no production execution provider;
2. fake-provider attachment tests;
3. direct-host fallback denial tests;
4. repository-wide dependency checks for removed sandbox modules;
5. tests that preserve generic worker/result/recovery/Git semantics without repository execution.

Stages 2–5 add VM subsystem/provider tests while normal repository task routing remains disabled.

Stage 7 adds real virtualization-capable qualification for Windows/Hyper-V and Linux/KVM-QEMU-libvirt. Hosted CI may not expose nested virtualization; self-hosted/dedicated provider-capable runners may be required.

## Documentation migration map

Stage 0 updates active docs so the architecture and sequence are unambiguous:

- `specs/DB-020-vm-execution-boundary.md` — normative target, provider parity, and intentional no-provider migration interval;
- `specs/DB-003-security.md` — security/threat/network/secret model;
- `specs/DB-008-git-supply-chain.md` — host Git authority + guest network/dependency model;
- `docs/architecture.md` — controller/provider/VM/bridge/dataflow overview;
- `docs/roadmap.md` — sandbox-first staging;
- `docs/vm-lego-studs.md` — unplug/delete/fake-provider/VM-attachment proof;
- setup/bootstrap/tool-profile docs — current legacy fields must not imply continued host repository execution;
- `AGENTS.md` — agents must not reintroduce host execution as a temporary fallback.

Historical handoffs/testing reports are preserved.

## Stage-0 sanity check

The revised sequence is consistent with project principles:

- **LEGO/SOLID:** physically removing the old brick before adding the new one is a stronger replaceability test than maintaining dual live providers;
- **security:** the intentional gap fails closed; repository code never runs directly on the trusted host merely because the sandbox was removed;
- **KISS:** avoids a long-lived dual sandbox+VM compatibility architecture;
- **correctness:** exposed coupling is repaired before provider implementation instead of copied into Hyper-V/KVM adapters;
- **recoverability:** provider absence is explicit durable state, not an implicit crash path;
- **Git/GitHub responsibility:** host credentials/authoritative refs remain independent of execution availability;
- **provider parity:** both Hyper-V and KVM/libvirt attach after the same sandbox-free boundary is proven;
- **setup UX:** Stage 8 turns the VM-only execution path into the supported install/reconfiguration experience.

No runtime code or live config schema is removed by Stage 0 itself.