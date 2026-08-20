# DevBridge architecture

## Purpose and current transition

DevBridge is a trusted local control plane that turns remote development requests into bounded local work without giving remote content direct machine authority.

DB-020 now defines the target repository-execution architecture: **persistent, networked virtual machines are the sole required repository-code security boundary**. The trusted controller remains on the host; each repository receives a persistent environment for each enabled guest OS/profile.

Current main has not completed that cutover. It still uses the verified Linux/Bubblewrap host sandbox for supported repository-code execution, while draft PR #106 contains superseded Windows ProcessContainer/AppContainer experimentation. Those implementations are migration scaffolding, not competing target architectures.

`docs/vm-migration.md` records what will be removed, retained, and blocked until replacement acceptance.

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
- VM-management authority;
- base-image registry and environment mapping.

Host code may run fixed/static control operations only when their implementation cannot be redirected into repository-controlled code.

### Untrusted repository environment

A repository environment is one persistent VM bound to a stable repository identity plus guest OS/profile and image generation.

Assume guest administrator/root compromise. The guest may control every guest-local process/file/service, package/tool installation, build/test output, coding worker, and guest Git repository. It also has normal network access by default.

Therefore the host does not expose secrets or authoritative writable state to it. Compromise of the guest may destroy or exfiltrate guest data; it must not grant host GitHub/publication/coordination/release/daemon/hypervisor authority.

No required Bubblewrap/AppContainer/ProcessContainer layer exists inside the guest.

## Control-plane flow

The target primary path is conceptually:

`TaskSource -> ProvenanceGate -> RunCoordinator -> LeaseGate -> Host Repository/Baseline -> Repository VM -> Host Bridge -> Verification/Import -> DecisionGate -> Host Seal/Publish -> Reconciler`

Detailed flow:

1. DevBridge obtains a typed task from the configured queue/source.
2. Provenance is verified against exact trusted actor/revision identity.
3. Local policy resolves the repository, semantic baseline, requested capabilities, guest OS/profile, and required execution environment.
4. DB-016 lease/fence state is acquired/revalidated when coordination is enabled.
5. The host prepares authoritative source/baseline state and resolves the exact persistent repository environment.
6. The host verifies provider/base-image/child-disk/environment/bridge readiness before repository execution.
7. Source/context/files cross the narrow bridge using logical identities/guest-relative paths, not arbitrary host paths.
8. Repository-controlled deterministic operations or optional coding workers execute inside the guest.
9. Results/candidate files return as untrusted data through the bridge.
10. The host validates exact run/repository/baseline/source/candidate identities and imports only permitted candidate bytes into authoritative host state.
11. DB-019 selects/reuses the required verification evidence; DB-007 handles consequential human gates without blocking unrelated safe work.
12. DevBridge seals the exact host candidate.
13. Before publication, lease, gate, verification, baseline, and remote predecessor state are rechecked.
14. Host Git/GitHub adapters perform the permitted effect with explicit expected state.
15. DB-009 observes/reconciles ambiguous external effects before retry.

## Persistent environment model

Repository environments are durable per stable repository identity + guest OS/profile.

Conceptually the host owns:

```text
base-images/
  <provider>/<guest-profile>/<image-generation>/immutable-base.vhdx

environments/
  <repository-id>/<guest-profile>/<environment-generation>/
    child-disk.vhdx
    lifecycle-state
    bridge-state
```

Exact paths/names are implementation detail and must remain host-local. Stage 1 defines the durable identity/state schema; Stages 2-3 implement Hyper-V image/disk/VM lifecycle.

Base images are immutable/versioned. Where Hyper-V supports it, repository state lives in a persistent differencing/child disk. Stopping the VM does not delete the child disk. Host/daemon restart reconciles the same environment rather than creating another one blindly.

Reset/reseed is explicit: discard a contaminated environment generation and reconstruct it from a trusted base plus authoritative repository inputs.

## Narrow host↔guest bridge

The bridge is the only normal command/file crossing between host control plane and repository guest.

It must support bounded:

- command/operation invocation;
- structured context/input;
- source/file transfer into the guest;
- result/evidence/candidate retrieval;
- exit/timeout/cancellation/liveness observation;
- exact repository-environment/run/operation identity.

Guest-controlled messages cannot name arbitrary host paths, host executables, Git refs, credentials, VM-management targets, or control-state objects.

Stage 4 deliberately selects the transport after platform research. The architecture does not prematurely require PowerShell Direct, Hyper-V sockets, a network RPC channel, or another mechanism. Transport can vary by guest OS if the same authority contract is preserved.

## Git and source/candidate model

Authoritative Git remains host-owned under DB-008/DB-017.

The guest may have ordinary Git and may create arbitrary commits/remotes. Those objects are untrusted development state. The host does not mount authoritative `.git` writable into the guest and does not give the guest publication credentials.

Source synchronization is host-to-guest. Candidate synchronization is guest-to-host. Stage 6 defines the exact incremental protocol and drift/conflict handling.

Host sealing/publication continues to use exact candidate/baseline identity and explicit expected remote predecessor state. A guest commit SHA is never publication authority by itself.

## Networking and secrets

Guests have networking enabled by default so package managers, SDK installers, documentation/source fetches, browser tests, coding services, and normal development tools work naturally.

This makes the confidentiality rule simple: **do not put host secrets in the guest**.

The following remain host-only:

- GitHub tokens/CLI credentials;
- host SSH agent/keys;
- coordination private keys;
- release/signing authority;
- daemon-control tokens/state;
- authoritative Git/publication state;
- hypervisor-management authority;
- arbitrary operator-home credentials.

Private dependency/coding-service workflows require later explicit scoped designs; they do not justify copying broad host credentials into persistent guests.

## Controller plans and deterministic operations

DB-013 plans remain data, not command authority.

DevBridge's local operation registry classifies execution:

- static/control operations may run on host only when they provably cannot execute repository-controlled code;
- repository-controlled operations execute inside the bound repository VM after Stage 6;
- unknown operations default to repository-controlled.

Controllers supply only bounded schema parameters, never raw shell/host argv/host paths/VM targets.

## Tool inventory and onboarding

DB-015 inventory reports observed capability; it never creates it.

Host inventory covers control-plane prerequisites such as Node, Git, Hyper-V/provider management, and bridge/bootstrap tools.

Repository toolchains are discovered/used inside the guest environment. Guest tool observations are bound to exact environment generation and remain untrusted planning evidence. Dynamic `tool.*` manifests/schema validation stays host-controlled, while actual repository-class probing/execution moves into the guest.

## Verification and evidence

DB-019 treats verification cost/evidence as control-plane state.

VM/provider/bridge/security changes are legitimate qualification triggers. Documentation-only Stage 0 does not require a real VM suite that cannot exist yet; later Stage 7 does.

Passing evidence should bind, as relevant, to:

- exact candidate/baseline;
- test/policy identity;
- host platform/architecture;
- VM provider;
- base-image identity;
- repository environment generation;
- bridge identity/version;
- relevant guest toolchain/config.

Restart/context rollover does not justify rerunning expensive tests when that exact evidence remains valid. Environment reset/reseed or candidate drift invalidates dependent evidence conservatively.

## Runtime supervision

DB-011 keeps release integrity, runtime artifact identity, activation, health checking, and last-known-good rollback on the trusted host.

Candidate-controlled preflight/tests are untrusted executable code. Current main uses the transitional Bubblewrap boundary; the DB-020 target copies/binds the exact candidate subject into an untrusted VM validation environment, collects evidence, rechecks host artifact identity, and only then drains/activates.

Candidate networking may be available; host secrets/control state are not.

## Recovery

DB-009's rule is universal:

> Persist intent/evidence, observe exact current state, reconcile ambiguity, then repeat only what remains necessary.

VM operations introduce durable objects that must participate in that rule:

- base images;
- child/differencing disks;
- repository environment records;
- VM lifecycle state;
- bridge operation/transfer state;
- source/candidate import subjects.

A missing in-memory handle is not evidence that a VM/disk disappeared. A failed guest command is not permission to delete persistent environment state. Deletion/reset/reseed requires exact ownership proof.

## Human checkpoints

DB-007 remains checkpoint-and-proceed.

Consequential decisions can gate a specific boundary while reversible work continues. Remote approval does not grant new host filesystem, credential, VM-management, executable, guest-secret, peer-trust, or publication capability.

## Workstation/resource governance

DB-018 currently provides serialized task admission, below-normal legacy host child priority, and cooperative pause/resume.

VM resource limits/observations belong to the provider layer. Stage 7 must report only CPU/memory/disk/process/lifecycle constraints Hyper-V can actually enforce and observe. Persistent disk growth/cleanup must be bounded without deleting unowned disks.

DB-020 does not create general parallel task scheduling.

## Initial provider and portability

The first implementation target is a Windows host using Hyper-V with persistent Windows and Linux guest environments.

Provider ports should describe real image/environment/lifecycle/bridge/readiness semantics, but the project must not build speculative multi-hypervisor abstraction at the expense of proving Hyper-V behavior. Additional providers are future adapters after the initial contract is qualified.

## Migration status

The VM program is issue #107:

1. Stage 0 — architecture/spec ratification and migration inventory (#108).
2. Stage 1 — VM contracts and repository/OS identity (#109).
3. Stage 2 — Hyper-V backend and base-image lifecycle (#110).
4. Stage 3 — persistent repository/OS VM disk/lifecycle (#111).
5. Stage 4 — host↔guest command/file bridge (#112).
6. Stage 5 — guest bootstrap/network/toolchain behavior (#113).
7. Stage 6 — route deterministic operations/workers/candidate execution (#114).
8. Stage 7 — verification/doctor/recovery/CI/resource/security acceptance (#115).
9. Stage 8 — installer/setup/reconfiguration integration (#116).
10. Stage 9 — remove legacy host sandbox stack and retire PR #106 (#117).

Current Bubblewrap coverage stays in place until replacement evidence exists. Do not delete the working transitional boundary during earlier VM stages.

## Documentation authority

`specs/DB-001` through `specs/DB-020` are the live normative contracts. DB-020 governs the target repository-execution security boundary.

`AGENTS.md`, this architecture document, `docs/vm-migration.md`, `docs/bootstrap.md`, `docs/tool-profiles.md`, `docs/testing/verification-governance.md`, and `docs/roadmap.md` describe the current engineering/operating view.

Checksum-bound handoffs and point-in-time testing audits are historical evidence. They remain valuable but do not override newer active specifications.
