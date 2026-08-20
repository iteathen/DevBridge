# DevBridge architecture

## Purpose and current transition

DevBridge is a trusted local control plane that turns remote development requests into bounded local work without giving remote content direct machine authority.

DB-020 defines the target repository-execution architecture: **persistent, networked virtual machines are the sole required repository-code security boundary**.

The initial host-provider set is first-class on both supported host families:

- Windows host -> Hyper-V;
- Linux host -> KVM/QEMU managed through libvirt.

Stages 0–6 are implemented on the VM migration stack. The Linux/Bubblewrap host-sandbox implementation is absent, while draft PR #106 remains superseded Windows ProcessContainer/AppContainer evidence.

The approved migration does **not** keep the legacy sandbox live until VM replacement is complete. Stage 1 removes active host-sandbox repository execution first, establishes an explicit fail-closed no-provider state, and uses that removal to expose/prove the LEGO connection studs. Stages 2–5 build the VM system while normal repository-controlled execution remains unavailable. Stage 6 restores repository execution through VMs only.

No direct/uncontained host fallback is allowed during the no-provider interval.

`docs/vm-migration.md` records the removal/retention inventory. `docs/vm-lego-studs.md` defines the unplug/delete/fake-provider/VM-attachment proof. `docs/vm-stage6-repository-execution.md` defines the restored route/source/candidate contract.

## Authority hierarchy

DevBridge owns authoritative:

- task/feedback/decision provenance;
- local capability policy;
- repository identity and authorized baselines;
- VM provider/image/environment lifecycle;
- host↔guest bridge admission;
- GitHub credentials and API mutation authority;
- coordination identity, leases, and fencing;
- authoritative Git/candidate/publication state;
- verification planning/evidence;
- checkpoints/hard-gate subjects;
- durable run/effect/recovery state;
- runtime release/activation/rollback state;
- daemon lifecycle/control state.

Remote controllers, coding models, repository content, dependencies, guest tools, tests, guest Git, and process output are inputs/proposals. They do not own control-plane truth.

## Trust domains

### Trusted host

The trusted host contains the DevBridge controller and host-only authority:

- GitHub and Git transport credentials;
- DB-016 coordination private keys;
- release/signing authority;
- authoritative Git administration and publication refs;
- daemon locks/control state;
- run/effect/checkpoint/verification journals;
- selected VM-provider management authority;
- base-image registry and environment mapping.

Host code may run fixed/static control operations only when their implementation cannot be redirected into repository-controlled code.

During the intentional Stage-1-to-Stage-5 no-provider interval, absence of a repository execution provider means repository-controlled work is unavailable. It never broadens the set of operations considered safe to run on the host.

### Untrusted repository environment

A repository environment is one persistent VM bound to stable repository identity + host provider + enabled guest OS/profile + image/environment generation.

Assume guest administrator/root compromise. The guest may control every guest-local process/file/service, package/tool installation, build/test output, coding worker, guest Git repository, and bridge helper/guest agent. It also has normal network access by default.

The host therefore exposes no secrets or authoritative writable state to it. Compromise of the guest may destroy/exfiltrate guest data; it must not grant host GitHub/publication/coordination/release/daemon/provider-management authority.

No required Bubblewrap/AppContainer/ProcessContainer layer exists inside the guest.

## Provider model

Controller logic depends on provider-neutral lifecycle/image/environment/bridge contracts. Provider adapters own platform details.

The Stage-1 sandbox-free state must remain structurally coherent with no production provider registered. A test fake may attach for architecture tests, but it is not a production security fallback.

### Windows / Hyper-V

The Hyper-V adapter owns:

- observed Hyper-V capability and management readiness;
- Hyper-V VM identity/configuration;
- immutable VHD/VHDX base-image inventory;
- per-repository differencing-disk lineage;
- provider networking;
- provider-specific lifecycle/recovery;
- the selected Hyper-V bridge transport(s).

### Linux / KVM-QEMU-libvirt

The Linux adapter owns:

- observed KVM acceleration and libvirt provider readiness;
- QEMU/libvirt domain identity/configuration;
- immutable base-image inventory;
- per-repository qcow2 backing/overlay lineage;
- libvirt/QEMU networking/storage ownership;
- provider-specific lifecycle/recovery;
- the selected libvirt/QEMU bridge transport(s).

The expected management direction is the locally authorized libvirt system provider, normally `qemu:///system`, unless Stage 2 research justifies a narrower equivalent adapter.

`/dev/kvm`, `virsh`, QEMU binaries, Hyper-V installation, or a VM/domain name alone are not readiness evidence.

## Control-plane flow

The target primary path after Stage 6 is conceptually:

`TaskSource -> ProvenanceGate -> RunCoordinator -> LeaseGate -> Host Repository/Baseline -> Repository VM -> Host Bridge -> Verification/Import -> DecisionGate -> Host Seal/Publish -> Reconciler`

Detailed flow:

1. DevBridge obtains a typed task from the configured queue/source.
2. Provenance is verified against exact trusted actor/revision identity.
3. Local policy resolves the repository, semantic baseline, requested capabilities, host provider, guest OS/profile, and required environment.
4. DB-016 lease/fence state is acquired/revalidated when coordination is enabled.
5. The host prepares authoritative source/baseline state and resolves the exact persistent repository environment.
6. The host verifies provider/base-image/writable-layer/environment/bridge readiness.
7. Source/context/files cross the narrow bridge using logical identities/guest-relative paths, not arbitrary host paths.
8. Repository-controlled deterministic operations or optional coding workers execute inside the guest.
9. Results/candidate files return as untrusted data through the bridge.
10. The host validates exact run/repository/baseline/source/candidate identities and imports only permitted candidate bytes into authoritative host state.
11. DB-019 selects/reuses required verification evidence; DB-007 handles consequential human gates without blocking unrelated safe work.
12. DevBridge seals the exact host candidate.
13. Before publication, lease, gate, verification, baseline, and remote predecessor state are rechecked.
14. Host Git/GitHub adapters perform the permitted effect with explicit expected state.
15. DB-009 observes/reconciles ambiguous external effects before retry.

Before Stage 6, repository-controlled paths stop at provider availability/admission and fail closed; they do not continue as host execution.

## Persistent environment and storage model

Base OS/tooling images are immutable/versioned. Repository writable state is provider-native copy-on-write state where supported.

Conceptually:

```text
base-images/
  <provider>/<guest-profile>/<image-generation>/<immutable-base>

environments/
  <repository-id>/<provider>/<guest-profile>/<environment-generation>/
    <provider-native-writable-layer>
    lifecycle-state
    bridge-state
```

Exact paths/names are host-local implementation detail.

Hyper-V uses differencing VHD/VHDX parent/child semantics. KVM/QEMU uses qcow2 backing/overlay semantics. Both relationships are identity-bearing state that must be revalidated rather than inferred from filenames.

Stopping a VM/domain does not delete its writable layer. Host/daemon restart reconciles the same environment rather than creating another one blindly.

Reset/reseed explicitly discards one contaminated environment generation and reconstructs it from an immutable base plus authoritative repository inputs. Reparent/rebase is never an implicit image migration shortcut.

## Narrow host↔guest bridge

The bridge is the only normal command/file crossing between host control plane and repository guest.

It supports bounded:

- command/operation invocation;
- structured context/input;
- source/file transfer into the guest;
- result/evidence/candidate retrieval;
- exit/timeout/cancellation/liveness observation;
- exact provider/environment/run/operation identity.

Guest-controlled messages cannot name arbitrary host paths, host executables, Git refs, credentials, provider-management targets, or control-state objects.

Stage 4 selects provider transports after research.

Relevant primitives include Hyper-V integration channels/sockets and Windows-specific PowerShell Direct, plus libvirt/QEMU virtio channels, QEMU Guest Agent, and vsock-capable transports.

QEMU Guest Agent is not trusted guest evidence: a compromised guest may forge responses. That is acceptable only because the host treats every bridge response as untrusted data and validates the resulting host-side subject independently.

## Git and source/candidate model

Authoritative Git remains host-owned under DB-008/DB-017.

The guest may have ordinary Git and arbitrary guest-local commits/remotes. Those are untrusted development state. The host does not mount authoritative `.git` writable into the guest and does not give the guest publication credentials.

Source synchronization is host-to-guest. Candidate synchronization is guest-to-host. Stage 6 defines exact incremental transfer and drift/conflict handling.

Host sealing/publication continues to use exact candidate/baseline identity and explicit expected remote predecessor state. A guest commit SHA is never publication authority by itself.

## Networking and secrets

Guests have networking enabled by default so package managers, SDK installers, documentation/source fetches, browser tests, coding services, and normal development tools work naturally.

The confidentiality rule is therefore simple: **do not put host secrets in the guest**.

The following remain host-only:

- GitHub tokens/CLI credentials;
- host SSH agent/keys;
- coordination private keys;
- release/signing authority;
- daemon-control tokens/state;
- authoritative Git/publication state;
- Hyper-V/libvirt/QEMU management authority;
- arbitrary operator-home credentials.

Private dependency/coding-service workflows require explicit later scoped designs; they do not justify copying broad host credentials into persistent guests.

## Controller plans and deterministic operations

DB-013 plans remain data, not command authority.

DevBridge classifies execution:

- static/control operations may run on host only when they provably cannot execute repository-controlled code;
- repository-controlled operations execute only inside the bound repository VM after Stage 6;
- unknown operations default to repository-controlled.

Controllers supply only bounded schema parameters, never raw shell/host argv/host paths/provider targets.

Provider absence never reclassifies repository-controlled work as host-safe.

## Tool inventory and onboarding

DB-015 inventory reports observed capability; it never creates it.

Host inventory covers control-plane/provider prerequisites:

- Windows: Node, Git, Hyper-V management/bootstrap tools;
- Linux: Node, Git, KVM/QEMU/libvirt management/bootstrap tools.

Repository toolchains are discovered/used inside the guest environment after VM restoration. Guest tool observations are bound to exact environment generation and remain untrusted planning evidence. Dynamic `tool.*` manifests/schema validation stays host-controlled, while actual repository-class probing/execution moves into the guest.

Without a ready routed environment, repository-class probes requiring execution are unavailable rather than redirected to host tools.

## Verification and evidence

DB-019 treats verification cost/evidence as control-plane state.

VM/provider/bridge/security changes are legitimate qualification triggers. Documentation-only Stage 0 does not require a real VM suite that cannot exist yet; Stage 7 does.

Passing evidence should bind, as relevant, to:

- exact candidate/baseline;
- test/policy identity;
- host platform/provider;
- base-image identity;
- repository environment generation;
- writable-layer lineage;
- bridge identity/version;
- relevant guest toolchain/config.

Restart/context rollover does not justify rerunning expensive tests when exact evidence remains valid. Environment reset/reseed/provider/image/candidate drift invalidates dependent evidence conservatively.

Stage 1 additionally requires cheap no-provider, fake-provider, dependency/removal, and direct-host-fallback-denial evidence.

## Runtime supervision

DB-011 keeps release integrity, runtime artifact identity, activation, health checking, and last-known-good rollback on the trusted host.

Candidate-controlled preflight/tests are untrusted executable code. Stage 1 removed the legacy host-sandbox candidate path. Stage 6 routes those checks through one local provider-native VM validation environment while DB-011 identity/rollback rules remain intact; absence fails closed.

Candidate networking may be available; host secrets/control state are not.

## Recovery

DB-009's rule is universal:

> Persist intent/evidence, observe exact current state, reconcile ambiguity, then repeat only what remains necessary.

VM operations add durable objects that participate in that rule:

- base images;
- VHDX differencing or qcow2 overlay chains;
- repository environment records;
- VM/domain lifecycle state;
- bridge operation/transfer state;
- source/candidate import subjects.

A missing in-memory handle is not evidence that a VM/disk disappeared. A failed guest command is not permission to delete persistent environment state. Deletion/reset/reseed requires exact ownership proof.

Provider removal in Stage 1 is also a recovery concern: durable work that depended on the deleted sandbox must reconcile to unavailable/failed state rather than being replayed through a direct-host fallback.

## Human checkpoints

DB-007 remains checkpoint-and-proceed.

Consequential decisions can gate a specific boundary while reversible work continues. Remote approval does not grant new host filesystem, credential, VM-management, executable, guest-secret, peer-trust, or publication capability.

## Workstation/resource governance

DB-018 currently provides serialized task admission, host child priority for trusted/provider processes, and cooperative pause/resume.

Host process priority is QoS, not containment and cannot justify repository execution on the host during the no-provider interval.

VM resource limits/observations belong to the provider layer. Stage 7 reports only CPU/memory/disk/lifecycle constraints Hyper-V or libvirt/QEMU can actually enforce/observe. Persistent disk growth/cleanup is bounded without deleting unowned storage.

DB-020 does not create general parallel task scheduling.

## Migration stages

Issue #107 is the active program:

1. Stage 0 — architecture/spec ratification and sandbox-first migration inventory (#108).
2. Stage 1 — remove host sandbox execution, expose/prove LEGO studs, establish fail-closed no-provider state (#109).
3. Stage 2 — Hyper-V + KVM/QEMU/libvirt host backends and base-image lifecycle (#110).
4. Stage 3 — persistent repository/OS writable-layer and VM lifecycle on both providers (#111).
5. Stage 4 — provider-adapted host↔guest command/file bridge (#112).
6. Stage 5 — guest bootstrap/network/toolchain behavior (#113).
7. Stage 6 — restore deterministic operations/workers/candidate execution through persistent VMs only (#114).
8. Stage 7 — provider/guest matrix verification/doctor/recovery/CI/resource/security/LEGO acceptance (#115).
9. Stage 8 — Windows/Linux installer/setup/reconfiguration integration (#116).
10. Stage 9 — finalize VM-only architecture and remove remaining migration scaffolding (#117).

Stages 2–5 deliberately operate while normal repository-controlled execution is unavailable. Do not reintroduce Bubblewrap/AppContainer/ProcessContainer or direct-host execution to bridge the gap.

## Documentation authority

`specs/DB-001` through `specs/DB-020` are the live normative contracts. DB-020 governs the target repository-execution security boundary and migration sequence.

`AGENTS.md`, this architecture document, `docs/vm-migration.md`, `docs/vm-lego-studs.md`, `docs/bootstrap.md`, `docs/tool-profiles.md`, `docs/testing/verification-governance.md`, and `docs/roadmap.md` describe the current engineering/operating view.

Checksum-bound handoffs and point-in-time testing audits are historical evidence. They remain valuable but do not override newer active specifications.
