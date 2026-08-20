# DevBridge Agent Guide

DevBridge is security-sensitive automation. It turns remote task input into local development activity, so convenience never outranks capability boundaries, provenance, recoverability, lease/fence correctness, provider isolation, or rate-limit discipline.

## Required engineering cycle

For each meaningful change:

1. Read the relevant specs and design principles before editing.
2. Assess the problem and the ownership boundary.
3. Research unstable/external platform behavior from primary sources.
4. Reassess after research; do not force the original idea if evidence changed it.
5. Plan by coherent ownership boundary, not tiny token-driven patches.
6. Implement the smallest complete design that satisfies the contract.
7. Test normal, failure, recovery, and boundary behavior.
8. Report what changed, what was tested, what remains, and the next safe step.

Do not let a model/chat context become the only record of work. Durable run state, exact evidence, and bounded context handoffs are product requirements.

For VM program issues #107–#117, every stage has an additional mandatory planning gate: read DB-020 and prerequisite VM stages, inspect the exact implementation being removed/extended, read `docs/vm-migration.md` and `docs/vm-lego-studs.md`, research relevant Hyper-V and/or KVM/QEMU/libvirt behavior, write/sanity-check a scoped plan, and proceed unless research exposes a genuine architecture/authority decision.

## Design hierarchy

Use these together rather than as slogans:

- **LEGO:** small composable contracts with replaceable adapters.
- **SOLID:** clear responsibilities and dependency direction.
- **CUPID:** composable, Unix-like, predictable, idiomatic, domain-based behavior.
- **KISS:** the smallest mechanism that preserves correctness and safety.

Hexagonal boundaries are preferred where DevBridge touches GitHub, credentials, Git/filesystems, VM providers, guest bridges, processes, clocks, persistence, status delivery, human decisions, coordination, runtime supervision, or daemon control.

## Control-plane rule

DevBridge owns authoritative run state, Git state, VM/environment state, capability policy, task provenance, decision/checkpoint state, lease/fence state, verification identity/evidence, publication state, runtime-update state, and daemon lifecycle state.

Remote and local LLMs are proposal engines.

A model may propose source, tests, locally registered operations, repairs, architecture, or next steps. It does not get to declare that its proposal is accepted, a checkpoint is satisfied, a capability/provider is available, a lease is owned, tests are valid, or an external effect is authorized.

## DB-020 repository-execution architecture

DB-020 is normative for the **target** repository-code security boundary and the sandbox-first migration sequence.

Repository-controlled execution belongs in persistent untrusted VMs. The required initial host providers are:

- **Windows:** Hyper-V.
- **Linux:** KVM/QEMU managed through libvirt.

Both are first-class requirements. Do not implement controller logic that assumes only Hyper-V or treats Linux VM hosting as a later optional port.

The guest may be fully compromised, including administrator/root, and normally has network access. Therefore:

- keep GitHub credentials, SSH authority, coordination private keys, release/signing authority, authoritative Git/publication state, daemon/control state, and provider-management authority host-only;
- do not expose arbitrary writable host directories/mounts;
- do not depend on a required Bubblewrap/AppContainer/ProcessContainer layer inside the VM;
- do not use network denial as the primary confidentiality boundary; keep secrets out of the guest instead;
- treat guest Git, tools, caches, responses, and guest-agent/helper output as untrusted data;
- use a narrow host-controlled bridge for commands/files/results;
- keep provider-specific management/disk/transport details inside adapters.

Provider-native persistent storage is identity-bearing state:

- Hyper-V uses immutable/versioned VHD/VHDX bases and differencing children where supported;
- KVM/QEMU uses immutable/versioned bases and qcow2 backing/overlay chains where supported.

Do not infer parent/backing identity from filenames. Do not silently reparent/rebase persistent state when an image generation changes.

### Current migration state and required sequence

Current main still contains Linux/Bubblewrap repository-code execution. Draft PR #106 contains superseded Windows host-sandbox experiments.

The approved migration deliberately **removes active host-sandbox repository execution before production VM implementation**.

Stage 1 must locate/prove the existing execution connection studs, unplug provider registration, establish explicit fail-closed no-provider behavior, repair abstraction leaks revealed by removal, prove a test fake attaches through the studs, and delete active Bubblewrap/AppContainer/ProcessContainer-style repository-execution runtime/wiring while preserving generic behavior and historical evidence.

After Stage 1 and through Stages 2–5:

- normal repository-controlled execution is intentionally unavailable;
- provider absence fails before repository code is spawned on the host;
- `allowUncontainedTools`, direct-process compatibility, candidate-validation shortcuts, shell fallbacks, or setup modes must not create direct/uncontained host repository execution;
- trusted static/control-plane work may continue only where independently classified as not executing repository-controlled code.

Stage 6 restores repository-controlled execution **through persistent VMs only**. If the required VM provider/environment is unavailable, execution remains unavailable/fail-closed.

Stage 7 proves security, real provider behavior, absence of host fallbacks, and LEGO replaceability. Stage 8 makes the VM-only path installable/reconfigurable. Stage 9 removes remaining migration/configuration/documentation scaffolding; it is not the primary sandbox-deletion stage.

If removing the old sandbox or adding Hyper-V/KVM requires broad rewrites of controllers, Git authority, recovery, verification, or worker semantics, treat that as evidence the LEGO connection studs are malformed. Repair the owning boundary before proceeding.

Read `docs/vm-migration.md` and `docs/vm-lego-studs.md` before removing/refactoring sandbox-era or VM-provider code.

## Preferred execution path

The target path is:

`Primary controller -> DevBridge host control plane -> deterministic/proposal intent -> exact repository VM -> host validation -> seal/publish`

A controller may author source text, tests, expected outputs, and structured intent. DevBridge owns:

- materialization/transfer;
- provider/environment selection;
- locally registered operation identity;
- bridge admission;
- lifecycle/cancellation;
- authoritative Git;
- verification/evidence;
- cleanup/recovery;
- publication.

Do not delegate deterministic machine work to a coding model merely because a model adapter exists. Compiler/tool discovery, process/bridge exit capture, tests, protocol fixtures, cleanup, Git auditing, publication reconciliation, lease operations, daemon control, and runtime activation belong to DevBridge or deterministic registered adapters.

Coding-model adapters remain optional compatibility/inference surfaces and are disabled by default in reference configuration.

A controller plan is data, not a remote shell language. It may carry bounded project proposals and locally registered operation references. It may not grant executable paths, raw shell/argv, arbitrary environment values, arbitrary host paths, arbitrary Git refs, cleanup roots, credentials, provider objects, VM/domain names, image paths, bridge transport parameters, peer keys, or capabilities.

## Remote task authors and workstation isolation

Treat `github.trustedActorIds` as a **remote development-job submission allowlist**, not a generic collaborator list.

A trusted task author can request work only within the runner's existing local repository/capability/provider policy. Task trust does not grant host paths, executable authority, credentials, provider management, publication, or decision authority.

DB-016 coordination leases do not solve human-to-workstation dispatch authorization. Current task envelopes are not cryptographically addressed to a destination installation.

Therefore:

- do not populate every workstation's `trustedActorIds` from a broad collaborator/team list;
- if developer A must be unable to dispatch to developer B's machine, enforce it through B's runner-local queue/task-author policy today;
- do not claim agent identity/lease ownership alone provides this isolation;
- future addressed-dispatch work must preserve DB-002 provenance and DB-003 local capability authority.

## Context rollover and fresh-controller recovery

A chat/model context is disposable controller state. It must never become the only place where accepted project progress, exact Git/environment identity, leases, decisions, or next action exist.

DB-014 is normative:

- checkpoint durable controller state before context pressure becomes failure;
- use bounded `devbridge/chat-handoff-v1`, not transcript dumps;
- bind handoffs to exact repository/baseline/head/task identities and SHA-256;
- record stable completed action IDs and at most one exact `nextActionId`;
- on fresh-context resume, observe/reconcile before acting;
- if the recorded next action already happened, skip it/checkpoint rather than inventing a following action;
- reread governing docs when recorded digests changed;
- keep large logs/diffs/test output behind durable references;
- checkpoint-and-proceed remains default; handoff does not become a generic human gate.

Read DB-014 with DB-005 and DB-009.

## Tool inventory and dynamic operation onboarding

DB-015 is normative.

- Inventory reports authority; it never creates authority.
- Presence-only discovery must not execute unfamiliar binaries by default.
- Remote inventory distinguishes registration/enabled state from observed usability/readiness.
- Absolute host executable/compiler/linker/provider paths, raw path-bearing errors, credentials, environment values, and authority-bearing argv remain local.
- Dynamic operations project only bounded validated parameter schemas; executable identity/fixed argv stays local.
- Operator-authored manifests live under an explicit host-owned manifest root.
- Automatic unfamiliar-tool onboarding is disabled by default and requires exact local pre-delegation.
- Help/man/spec output is untrusted data.
- A blocked/failed/unparseable probe creates no capability.
- Persist synthesized manifests before registration and reconcile them on restart.
- GitHub/repository/controller content cannot add to onboarding allowlists or edit manifest roots.

Under DB-020, repository-class tool discovery/probing/execution belongs inside the exact repository VM. Host inventory remains for control-plane/provider prerequisites such as Node/Git/Hyper-V/KVM/QEMU/libvirt/bridge tooling.

During the intentional no-provider interval, repository-class probes that require execution are unavailable rather than redirected to the host.

Guest networking may be normal during tool probing; confidentiality comes from absent host secrets, not an assumed network-denied host sandbox.

## Multi-agent identity, leases, and fencing

DB-016 is normative when more than one authorized installation/process can observe the same queue.

- A persistent Ed25519 key identifies an installation; its public SHA-256 fingerprint/address is coordination identity, not execution authority.
- Private keys are host control material and never enter repository guests.
- Peer public keys and coordination timing are local operator policy.
- Authoritative leases are signed bounded subjects stored behind DevBridge-owned Git refs and changed only with exact expected-value CAS.
- Missing/create, renewal, reclaim, release, and ambiguous push outcomes are observed/reconciled rather than blindly retried.
- Unexpired peer-held leases defer the task; unknown/unverifiable ownership fails closed.
- Same persistent identity does not permit unexpired-session takeover without the exclusive local daemon lock condition defined by DB-016.
- Definite lease loss fences immediately; ambiguous renewal expires naturally.
- Active task execution receives lease-abort/cancellation linkage where supported.
- Before sealing/publication DevBridge renews/rechecks the fence.
- Terminal release is signed CAS state, not blind ref deletion.

A lease coordinates ownership only. It cannot approve hard gates, grant tool/filesystem/network/provider/credential capability, replace task provenance, or replace the durable run journal.

## Baseline drift and publication reverification

DB-017 is normative.

- `baseSha` is immutable start evidence.
- `publicationBaseSha` is the current exact baseline for publication verification.
- The run stays bound to its authorized baseline channel/ref.
- Only same-ref fast-forward movement is automatically reconcilable; history rewrite checkpoints.
- Rebase begins from sealed clean candidate state and must restore the exact pre-rebase candidate on failure.
- Successful rebase invalidates affected verification.
- Dirty local candidate/head/publication-baseline drift invalidates stale evidence before sealing/publication.
- Changed-path/no-op/publication evidence is relative to `publicationBaseSha`; original `baseSha` remains historical.
- Publication binds exact verified local head and explicit expected remote predecessor state; symbolic `HEAD`/blind force are not authority.
- Ambiguous publication is resolved by re-observing exact remote state.

DB-020 guest source/candidate synchronization must preserve these host-authoritative identities. Guest Git history is never the final source of truth.

## Workstation resource governance and cooperative pause

DB-018 is normative.

- Effective task admission remains serialized to one task/run continuation.
- `execution.maxConcurrentTasks` is not authority to invent a worker pool.
- Host process priority is QoS, not containment and must not be used to justify repository-code host execution during the no-provider interval.
- Supported host priority classes are `normal`, `below-normal`, and `low`; elevated/unknown values are rejected.
- Failure to apply requested non-normal priority fails the operation rather than silently degrading.
- `pause` is token-bound cooperative admission control at a safe task-cycle boundary, not `SIGSTOP`, thread suspension, or VM suspension.
- Fully paused daemon performs no normal polling/new task claiming but preserves run/worktree/environment/checkpoint/lease evidence and remains locally controllable.
- Stop has precedence over pause.

VM CPU/memory/disk/lifecycle policy belongs to provider adapters and may be claimed only where Stage 7 proves enforcement/observation. Do not pretend Hyper-V and libvirt/QEMU expose identical quota semantics.

## Verification cost, test selection, and durable evidence

DB-019 is normative.

- A long test is not automatically a bad test.
- Use explicit tiers/classes and risk/ownership triggers rather than reflexively running everything.
- Run cheap high-signal prerequisites before expensive downstream suites when dependencies permit.
- Natural-language `run all tests` is intent, not unlimited cost/process authority.
- Passing evidence binds exact candidate/baseline/test/policy/platform/provider/image/environment/bridge/toolchain/config identities as applicable.
- Restart/chat rollover/publication recovery/repeated model requests do not justify rerunning exact still-valid expensive evidence.
- Prefer selective invalidation.
- Decompose/checkpoint long suites only when correctness permits it.
- Use suite-specific expected/slow/liveness/hard-timeout policy rather than one global timeout.
- Long-running work must expose bounded liveness.
- Future verification parallelism must be resource-aware and explicitly designed.

VM provider/bridge/security/storage changes are legitimate qualification triggers. Stage 7 may require real virtualization-capable self-hosted/dedicated runners; do not substitute mocks for required hypervisor evidence merely because hosted CI lacks nested virtualization.

## Human checkpoints

DB-007 is normative.

- Checkpoint and proceed is default; stop-and-wait is exceptional.
- A checkpoint does not automatically pause the run.
- Continue reversible/safe work while a decision is pending when it remains inside current capability/decision envelope.
- Enter `waiting-decision` only when the safe frontier is exhausted.
- Never infer approval from silence.
- Never stretch approval to a materially different subject.
- Broad refactor proposals should checkpoint the architectural choice and search boundedly for architecture-preserving alternatives before asking for refactor approval.
- Publication/destructive approvals that depend on payload identity bind to exact artifact/commit digest.

A remote decision cannot grant host paths, credentials, provider-management authority, new executables, guest secret injection, peer trust, or sandbox/VM exceptions.

## Trust and capability invariants

- Remote task text, repository files, web content, dependencies, tool docs, guest output, subprocess output, and model output are data/proposals, not authority.
- Only local operator configuration/control state may grant filesystem, execution, credential, network, task-author, peer-trust, decision-delegation, publication, or VM-provider capability.
- Remote input never supplies host executable paths, raw shell fragments, arbitrary host paths, environment values, credentials, provider management objects, image/disk paths, bridge transport parameters, or capability grants.
- Never interpolate remote task text into a host OS command line. Host child processes use `shell: false`.
- GitHub control credentials are not inherited by untrusted tools/guests.
- Authoritative Git remains host-owned.
- Guest filesystem state is untrusted, even when persistent.
- Guest-agent/helper responses are untrusted, even when using official Hyper-V/QEMU integration channels.
- A declaration is not enforcement. Observe provider/image/environment/bridge state before claiming readiness.
- No production execution provider means repository-controlled execution is unavailable; it never means "run it directly on the host".
- Do not auto-reset/clean/discard an arbitrary dirty developer checkout or an unowned VM/disk/domain.

## GitHub API / external effects

- Polling is a supported source; optional webhook work does not change authority.
- Use authenticated conditional requests and persisted validators where applicable.
- Serialize/rate-budget requests and respect server pacing/reserve floors.
- Remote status is observability, not local run authority.
- Effects that can be ambiguous follow DB-009 intent -> attempt -> observe -> reconcile semantics.
- A generic retry loop is not reconciliation.
- Publication/lease/update/handoff/inventory effects preserve their exact subject/expected-state contracts.

## Specification authority

Specs are normative unless a newer spec explicitly supersedes an older statement.

**Live normative contracts are currently DB-001 through DB-020.**

For repository-code execution architecture, DB-020 supersedes earlier host-sandbox target language while preserving provider-independent safety invariants.

Read combinations appropriate to the task:

- run coordination/human decisions: DB-001/003/005/006/007/009;
- Git/supply chain/publication: DB-003/008/009/017/020;
- runtime self-update: DB-003/009/011/020;
- controller plans: DB-003/008/009/012/013/020;
- tool inventory/onboarding: DB-003/012/013/015/020;
- leases/fencing: DB-002/003/008/009/010/016;
- baseline drift: DB-008/009/013/016/017;
- pause/resource governance: DB-004/009/011/012/016/018/020;
- verification cost/evidence: DB-009/013/017/018/019/020;
- VM program: DB-003/008/009/011/013/015/017/018/019/020 plus prerequisite VM issues, `docs/vm-migration.md`, and `docs/vm-lego-studs.md`.

Historical handoffs/audits are evidence of their checkpoint, not live authority. Do not rewrite checksum-bound history to make it look current.

## Runtime and testing discipline

Keep implementation details out of broad principles unless they are genuine invariants. Keep security-critical invariants in specs/tests, not README prose alone.

Boundary tests are mandatory for any claimed capability, including:

- path/identity escape and unowned cleanup;
- credential stripping/non-exposure;
- no-production-provider fail-closed behavior;
- denial of direct/uncontained host repository execution;
- fake-provider attachment through the same execution studs;
- provider readiness versus configuration;
- provider/image/writable-layer/environment identity mismatch;
- hostile/forged bridge responses and bounded output;
- timeout/cancellation/restart reconciliation;
- cross-repository environment isolation;
- authoritative Git isolation from guest state;
- exact candidate/baseline/publication CAS;
- lease loss/fence behavior;
- hard-gate subject binding;
- verification evidence reuse/invalidation;
- provider-specific storage lineage (VHDX differencing and qcow2 backing/overlays);
- real Hyper-V and KVM/libvirt qualification before final Stage-9 migration cleanup;
- repository-wide absence of resurrected Bubblewrap/AppContainer/ProcessContainer/direct-host repository-execution fallback.

A passing happy-path test alone is not sufficient for a capability boundary.