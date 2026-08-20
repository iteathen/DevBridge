# VM migration and legacy-sandbox removal inventory

Status: active migration map for DB-020 / issue #107.

This document records what the VM program replaces, what remains valuable, and exactly when removal becomes safe. It is not permission to delete runtime code during Stage 0.

## Governing rule

DB-020 is the target repository-execution architecture.

The required initial host providers are:

- Windows -> Hyper-V;
- Linux -> KVM/QEMU managed through libvirt.

The current Linux/Bubblewrap path and experimental Windows ProcessContainer/AppContainer work in draft PR #106 are temporary migration scaffolding/historical implementation evidence.

Do not extend the host sandbox stack as the long-term answer to repository execution. Security fixes that keep an interim path from becoming less safe are still allowed until the replacement path is accepted.

Full removal happens only after the named replacement stage has produced exact evidence on both required host providers. A mechanism being architecturally superseded is not enough reason to delete the only currently working Linux execution boundary.

## Stage-0 planning conclusions

The architecture now fixes these invariants:

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
- bridge/controller contracts are provider-neutral without pretending Hyper-V and libvirt expose identical raw state.

The following choices are deliberately deferred to their owning stages rather than treated as Stage-0 blockers:

- exact provider/environment/config schema and stable environment identifier — Stage 1;
- Hyper-V management API details, KVM/libvirt management details, and image construction flow — Stage 2;
- exact VM/domain/disk naming, start/stop, storage-pool and reseed mechanics — Stage 3;
- exact Hyper-V and libvirt/QEMU bridge transports, framing, authentication/identity, binary transfer, and recovery — Stage 4;
- exact guest bootstrap/package/tooling baseline — Stage 5;
- source synchronization, candidate import, coding/model adapter topology, and private/authenticated service access without host-secret injection — Stage 6;
- exact provider/guest qualification matrix, doctor evidence, recovery probes and provider resource policy — Stage 7;
- installation/reconfiguration prompts, provider provisioning, and migration UX on Windows/Linux — Stage 8.

## Researched provider primitives

Stage 0 does not select final transport APIs, but the architecture is grounded in real provider mechanisms.

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

QEMU Guest Agent is guest-controlled and may produce forged/spurious responses under a hostile guest. It is therefore a transport candidate, not an authority source. Host validation remains mandatory.

## Category 1 — remove after VM replacement

### Linux Bubblewrap provider

Current main:

- `src/runtime/bubblewrap-sandbox.js`
- `src/runtime/bubblewrap-probe.js`
- Bubblewrap-specific status constructors/fields in `src/runtime/sandbox-status.js`
- Bubblewrap selection/normalization in `src/runtime/deterministic-sandbox.js`
- Bubblewrap-specific package/AppArmor setup in `.github/workflows/ci.yml`
- Bubblewrap-specific setup/docs/spec/test assumptions

**Removal blocker:** Linux/KVM-QEMU-libvirt must be implemented, qualified in Stage 7, and installable/reconfigurable in Stage 8. Stage 9 must not remove Bubblewrap first and leave Linux hosts unable to execute repository code.

### Windows ProcessContainer/AppContainer experiment

Draft PR #106 contains the experimental Windows host-sandbox family. It is useful evidence but no longer the target architecture.

Files/families include or have included:

- `src/runtime/windows-processcontainer-sandbox.js`
- `src/runtime/windows-processcontainer-compat-provider.js`
- `src/runtime/windows-job-launcher.cs`
- `src/runtime/windows-job-wrapper.ps1`
- `src/bootstrap/windows-sandbox-runtime.mjs`
- Windows sandbox provisioning/qualification workflow code
- Windows ProcessContainer/AppContainer/MXC/native-helper tests

AppContainer SID reaping, Job Object experiments, ACL work, MXC provisioning, native AppContainer helpers, and compatibility naming are not required by DB-020.

**Removal/retirement blocker:** Windows/Hyper-V Stage-7 qualification + Stage-8 setup integration. Stage 9 closes/retires PR #106 and deletes any merged/transplanted remnants that are no longer referenced.

### Host-filesystem sandbox policy

Target-obsolete repository-execution concepts include:

- exposing host `workspace.externalReadRoots` to repository processes;
- host project write + subtractive `.git` protection as the isolation model;
- host `/usr`, `/bin`, `/lib*`, SDK/toolchain read-root construction for repository workloads;
- synthetic host HOME/TMP mounts used to hide operator state from repository processes;
- host namespace network `deny`/`unrestricted` as the primary confidentiality boundary;
- sandbox-specific host outside-read/write/network probes.

Config/document compatibility may remain temporarily so existing installations can start during migration. Stage 8 defines migration behavior; Stage 9 removes/deprecates obsolete fields cleanly.

### Gitless host project projection

Draft PR #106 introduced `src/runtime/project-projection.js` and tests to provide a disposable Gitless host project view.

DB-020 replaces this with a persistent guest filesystem plus host↔guest source/candidate synchronization. The invariant worth retaining is **authoritative Git is never guest authority**; the specific host Gitless projection is removable.

**Removal blocker:** Stage 6 source sync/candidate import/drift/reseal acceptance + Stage 7 qualification.

### Sandbox-specific worker IPC mount plumbing

Bubblewrap maps control-owned host files into fixed guest-like host namespace paths. PR #106 adds Windows staging/import variants because writable ACL semantics differ.

The host bind/ACL mechanism is target-obsolete. The logical run/turn/result protocol is not.

**Removal blocker:** Stage 4 bridge + Stage 6 worker result recovery acceptance on Hyper-V and KVM/libvirt.

## Category 2 — refactor / retain

### Generic process/result behavior

Retain provider-independent behavior from:

- `src/runtime/process-runner.js`
- `src/runtime/deterministic-process-runner.js`
- bounded stdout/stderr capture, timeout/cancellation, result parsing, failure classification
- `src/runtime/process-tree.js` where it still owns host-side helper/provider processes.

Refactor repository execution so the runner invokes a provider/environment/bridge adapter rather than preparing a host sandbox launch.

### Deterministic operation registry and classification

Retain:

- `src/runtime/deterministic-operation-registry.js`
- closed parameter schemas and local executable/operation authority;
- fail-closed classification of unknown/dynamic operations as repository-controlled.

Repository-controlled classes target the exact VM environment. Truly static/control operations remain host-side only when proven not to execute repository-controlled code.

### Worker/result protocols

Retain semantic invariants from:

- `src/runtime/worker-exchange.js`
- `devbridge/worker-exchange-v1`
- `devbridge/result-v1`
- run/turn/context digest binding
- bounded result size/parsing
- control-owned consumption and recovery.

Refactor current hard-link/inode/fixed host-mount implementation into bridge transfer objects/state. Guest output remains untrusted.

### Controller plans and proposal semantics

Retain DB-013:

- plans are data, not shell authority;
- executable/argv/environment/path/provider authority stays local;
- project proposals are not accepted Git state until host validation/sealing;
- cleanup/assertions/context receipts and deterministic schemas remain controller-owned.

### Authoritative Git/publication

Retain intact in principle:

- host-managed canonical repository identity/baseline resolution;
- DB-017 publication baseline/candidate identity;
- host staging/sealing/commit creation;
- explicit expected remote-head CAS/reconciliation;
- host-only GitHub/SSH publication credentials;
- publication/merge/release authority.

Stage 6 changes how source/candidate bytes cross the VM boundary, not who owns Git authority.

### Recovery, leases, checkpoints, verification, supervision

Retain:

- DB-009 durable effects/reconciliation;
- DB-007 checkpoint-and-proceed/hard gates;
- DB-016 host-only identity/lease/fencing;
- DB-018 cooperative daemon pause and local resource authority;
- DB-019 risk-driven verification/exact durable evidence;
- DB-011 release identity, candidate artifact identity, last-known-good, activation and rollback;
- runtime/daemon lifecycle control.

Refactor to add host platform/provider/image/writable-layer/environment/bridge identities as recovery/evidence inputs.

### Tool inventory/onboarding

Retain DB-015 observation-vs-authority, manifest/schema validation, bounded help parsing, secret-safe projection, and operation registration.

Refactor repository-class discovery/probing/execution into the guest. Host inventory remains for control-plane prerequisites:

- Hyper-V tools/readiness on Windows;
- KVM/QEMU/libvirt tools/readiness on Linux.

## Category 3 — historical evidence

Preserve, do not rewrite:

- `docs/handoffs/DB-HO002-0819-1226.md` and checksum on PR #106;
- `docs/handoffs/DB-HO004-0819-1702.md` and checksum on PR #106;
- `docs/handoffs/DB-HO004-0819-1902.md` and checksum on PR #106;
- older sandbox/security testing reports under `docs/testing/`;
- Git history, PR #106 discussion, CI runs, and failed/superseded experiments.

Useful lessons to carry forward:

- configuration/provider presence is not enforcement evidence;
- process/operation-tree ownership and cancellation must survive detached behavior;
- writable result transport needs identity/replacement defenses;
- authoritative Git should remain structurally outside untrusted execution;
- a failed integration disproves that implementation, not necessarily the underlying OS primitive;
- cross-platform path/identity semantics must be explicit;
- a guest agent/helper is not trusted merely because it is the official integration channel.

## Category 4 — blocked removal matrix

| Legacy family | Replacement evidence required | Earliest removal owner |
| --- | --- | --- |
| Bubblewrap provider/probe/status | Linux KVM/libvirt provider + image + persistent environment + bridge + Stage-7 Linux-host boundary/workload acceptance + Stage-8 setup | Stage 9 |
| Windows ProcessContainer/AppContainer/MXC/native helper | Hyper-V provider + image + persistent environment + bridge + Stage-7 Windows-host boundary/workload acceptance + Stage-8 setup | Stage 9 |
| host `externalReadRoots` repository semantics | guest tooling/source flow works on both host providers without host path exposure; Stage-8 config migration defined | Stage 9 |
| host sandbox network deny/share policy | network-on guest contract qualified with no host secrets on both providers | Stage 9 |
| Gitless host projection | Stage-6 source sync/candidate import + drift/reseal acceptance on required providers | Stage 9 |
| sandbox bind/ACL worker mailbox plumbing | Stage-4 bridge + Stage-6 worker result recovery acceptance on both provider families | Stage 9 |
| sandbox-specific candidate validation | candidate-controlled tests execute through provider-native VM validation on Windows and Linux while DB-011 invariants pass | Stage 9 |
| Bubblewrap/AppContainer qualification CI | Stage-7 real Hyper-V + KVM/libvirt qualification exists and is stable | Stage 9 |
| sandbox-specific config/schema/help text | Stage-8 Windows/Linux setup migration handles existing installs | Stage 9 |
| sandbox-specific tests | corresponding VM/provider/bridge/security/recovery tests cover retained invariants | Stage 9 |

## Concrete current-main ownership map

### Host sandbox implementation to replace

- `src/runtime/bubblewrap-sandbox.js`
- `src/runtime/bubblewrap-probe.js`
- `src/runtime/deterministic-sandbox.js` provider selection/factory
- `src/runtime/sandbox-status.js` sandbox-specific status vocabulary
- sandbox-specific branches in `src/runtime/process-runner.js`
- sandbox-specific branches in `src/runtime/deterministic-process-runner.js`
- candidate sandbox use in `src/bootstrap/candidate-validator.mjs`.

Likely target refactors replace these with provider/image/environment/bridge readiness rather than preserving a generic `sandbox` name indefinitely.

### Control-plane infrastructure to retain/refactor

- `src/runtime/process-runner.js`
- `src/runtime/deterministic-process-runner.js`
- `src/runtime/deterministic-operation-registry.js`
- `src/runtime/worker-exchange.js`
- host-owned helper lifecycle utilities
- runtime state/recovery/coordinator/Git/publication modules
- DB-007/009/016/017/018/019 enforcement/evidence paths
- bootstrap release-integrity and supervisor activation/rollback logic.

### Configuration requiring Stage-8 migration design

Current `config/devbridge.example.json` includes:

- `workspace.externalReadRoots`
- `execution.allowUncontainedTools`
- local tool profiles whose `sandbox` fields describe host filesystem/network semantics
- no VM provider/image/environment configuration section.

Stage 1 defines new state/contracts; Stage 8 defines operator migration/reconfiguration. Stage 0 does not mutate the live config schema.

### CI/tests requiring later replacement

Current `.github/workflows/ci.yml` installs/configures Bubblewrap/AppArmor on Linux and gates Linux sandbox tests.

Do not remove that coverage while Linux host-sandbox execution remains live.

Stage 7 adds real virtualization-capable qualification for:

- Windows/Hyper-V;
- Linux/KVM-QEMU-libvirt.

Hosted CI may not expose nested virtualization. Self-hosted/dedicated provider-capable runners may be required; that infrastructure fact must be explicit rather than hidden behind mocks.

Test semantics that survive the migration include fail-closed provider readiness, exact environment/evidence identity, secret non-exposure, authoritative Git isolation, bounded bridge/results, timeout/cancellation, lifecycle cleanup, recovery, candidate sealing, storage-lineage validation, and end-to-end workload acceptance.

## Documentation migration map

Stage 0 updates active docs so the architecture is unambiguous:

- `specs/DB-020-vm-execution-boundary.md` — normative target and provider parity;
- `specs/DB-003-security.md` — security/threat/network/secret model;
- `specs/DB-008-git-supply-chain.md` — host Git authority + guest network/dependency model;
- related execution/tool/runtime specs — defer to DB-020 for the target boundary;
- `docs/architecture.md` — controller/provider/VM/bridge/dataflow overview;
- `docs/roadmap.md` — issue #107 stages and both initial providers;
- `docs/setup.md` / `docs/bootstrap.md` — distinguish current Bubblewrap behavior from future Hyper-V/KVM-libvirt setup;
- `docs/tool-profiles.md` — host sandbox fields are transitional; guest tooling is target;
- `AGENTS.md` — agents must not extend the old sandbox architecture as target and must preserve provider parity;
- `README.md` — user-facing current-vs-target status.

Historical handoffs/testing reports are not rewritten.

## Stage-0 sanity check

The dual-provider direction is consistent with project principles:

- **correctness/containment:** the guest is the untrusted trust domain on both Windows and Linux hosts;
- **recoverability:** provider/image/writable-layer/environment identities become DB-009 state; persistence is independent of command lifetime;
- **Git/GitHub responsibility:** host credentials/authoritative refs never enter the guest;
- **operator trust:** doctor reports observed provider/image/environment readiness, not configured aspirations;
- **LEGO/SOLID:** Hyper-V and KVM/libvirt are replaceable provider adapters behind one contract;
- **KISS:** two native host providers replace multiple host-process sandbox schemes without requiring nested sandboxing or a custom network proxy;
- **checkpoint-and-proceed:** later stages can proceed independently unless research exposes a genuine authority choice;
- **DB-019:** cheap contract/unit checks precede expensive real-provider qualification, while Stage-7 provider/security changes still trigger required evidence;
- **setup UX:** Stage 8 owns discover-first provider provisioning on Windows and Linux;
- **portability:** Linux is not treated as a future optional backend; it is a first implementation requirement.

No runtime code or live config schema is removed by Stage 0.
