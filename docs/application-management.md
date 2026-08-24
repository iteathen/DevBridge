# DevBridge application management architecture

## Purpose

DevBridge separates the permanent machine entry point from the software and infrastructure that it manages.

The governing application-management hierarchy is:

```text
Permanent DevBridge Entry
        |
        v
Runner / Bootstrap Manager
        |
        v
Accepted DevBridge Runtime
        |
        v
DevBridge Services
        |
        v
Declared Execution Environments
```

Configuration and installation identity are stored separately from replaceable executable generations.

This structure deliberately follows the mature application-management pattern used by products that keep a stable launcher/manager distinct from managed application versions, while adding stronger transactional and last-known-good recovery requirements appropriate to DevBridge. External products are design references only; they are not dependencies or normative authorities.

The core rule is:

> **Each layer may reconstruct or replace the layer immediately below it. No lower layer may be the only authority required to reconstruct its owner.**

This document defines ownership between the application-management layers. VM/provider details remain governed by DB-020 and the environment lifecycle program.

## Layer 1: permanent DevBridge entry

The permanent entry is the smallest and most stable installed component.

Its contract is intentionally narrow:

```text
local selector -> exact verified runner subject -> argv handoff
```

It may:

- resolve a locally authorized stable or explicit development selector;
- resolve that selector to one exact immutable runner subject;
- acquire/materialize the exact runner when it is absent;
- verify the complete runner subject before launch;
- use a verified last-known-good runner when source policy permits;
- invoke the selected runner without a shell;
- expose bounded entry/runner status.

It must not:

- implement normal DevBridge business logic;
- own repository/task workflow;
- manage Hyper-V/libvirt objects;
- construct VMs or images;
- own model adapters;
- parse remote task text into application-management authority;
- contain normal runtime update, daemon, publication, or workspace logic;
- depend on the accepted DevBridge runtime in order to recover that runtime.

The permanent entry should change only when its own compatibility/trust contract must change. Ordinary DevBridge releases must not require replacing it.

Issue #159 owns this layer.

## Layer 2: runner / bootstrap manager

The runner is replaceable software selected and verified by the permanent entry. It owns the mechanics needed to establish a usable managed DevBridge runtime.

The runner may:

- create/reconcile the managed runtime location;
- acquire exact runtime/release subjects under local release policy;
- verify runtime identity, integrity, compatibility, and required bootstrap protocol;
- materialize candidate or replacement runtime generations separately from the currently accepted generation;
- recover when the accepted runtime is absent, corrupt, or too old to reach its own updater;
- hand off into the runtime's secure bootstrap/supervisor path;
- preserve exact last-known-good runtime evidence where one exists;
- report when an older permanent-entry protocol cannot safely support an automatic transition.

The runner is not a second DevBridge application implementation. It must not absorb repository execution, provider lifecycle, setup policy, or ordinary service logic.

DB-011 remains authoritative for runtime release integrity and activation semantics. While a healthy accepted runtime can perform its normal supervised update path, it should do so. The runner exists both as the installation/bootstrap path and as the bounded escape path when that accepted runtime is absent or cannot perform the transition needed to repair itself.

Issue #153 owns the stale/incompatible-runtime escape-path defect. Issue #159 owns how the permanent entry reaches a suitable runner without depending on the failing runtime.

## Layer 3: accepted DevBridge runtime

The accepted runtime is the current verified DevBridge application generation.

It owns normal DevBridge application behavior, including:

- secure bootstrap after the application-management handoff;
- runtime supervisor and daemon lifecycle;
- local configuration interpretation;
- setup and setup re-entry orchestration;
- capability and authority policy;
- provider/environment lifecycle composition;
- task/run coordination;
- repository execution routing;
- verification, Git, publication, and recovery orchestration.

The accepted runtime is replaceable implementation state. Its files are not installation identity and are not the sole copy of operator configuration.

An accepted runtime must never require in-place mutation to update itself. Candidate/replacement runtime generations are materialized and verified separately, then activated through a journaled transition with exact current/candidate identity and last-known-good behavior where applicable.

## Layer 4: DevBridge services

Services are processes owned by the accepted runtime, such as the supervisor, daemon, local control surfaces, and narrowly privileged provider-control services/helpers where the platform requires them.

Service processes are operational instances, not durable application identity.

They may be stopped, restarted, replaced, or recreated from the accepted runtime and durable installation/configuration state.

A service crash or deletion must not require reinstalling DevBridge manually.

Provider-control authority, where introduced by #177, remains narrower than the normal runtime and does not become a general privileged shell or file service.

## Layer 5: declared execution environments

Execution-profile VMs, their system disks, base-image cache entries, guest bootstrap/tooling state, bridge enrollment, and repository workspace materialization are subordinate infrastructure managed by the accepted runtime.

The environment declaration and host-owned lifecycle evidence are durable authority. VM/domain instances and guest system disks are replaceable implementation generations.

Issue #169 and its focused lifecycle issues own this layer. In particular:

- #170 owns desired/observed environment state and lifecycle journaling;
- #178 owns recoverable immutable base-image acquisition/cache reconstruction;
- #171 owns the shared construction pipeline and `create`;
- #172 owns diagnosis/repair classification;
- #173 owns `rebuild`;
- #174 owns `reset`;
- #175 owns `recreate`;
- #176 owns lifecycle/setup/re-entry UX;
- #177 owns provider/storage authority isolation.

## State that is separate from executable generations

The following concepts must not be conflated with runner/runtime/service files:

### Installation identity

One logical DevBridge installation keeps a stable installation identity across runner/runtime updates and service restarts.

Changing runtime generation does not create a new installation identity.

### Operator configuration and authority

User-approved repositories, trusted actors, execution profiles, release policy, provider policy, lifecycle declarations, and similar authority-bearing choices are durable local control state.

They are not silently regenerated from repository content, model output, guest state, filenames, provider object names, or a replacement runtime.

### Runtime activation / last-known-good evidence

Accepted runtime identity, candidate identity, activation state, and last-known-good evidence are durable application-management state. They must survive process restart and must be reconciled after interrupted transitions.

### Environment desired state

Environment declarations and lifecycle journals are durable control-plane state, separate from the current provider materialization.

## Replaceability direction

The dependency direction is strictly downward:

```text
Permanent Entry
  reconstructs Runner

Runner
  reconstructs Accepted Runtime

Accepted Runtime
  reconstructs Services
  reconstructs Declared Execution Environments

Services / Execution Environments
  do not reconstruct or authorize their owners
```

A lower layer may provide observations or untrusted data to an upper layer. It does not become the authority from which the upper layer is reconstructed.

This prevents circular recovery dependencies such as:

- needing the accepted runtime in order to install the runner that repairs the accepted runtime;
- needing a repository VM in order to recover the runtime that creates repository VMs;
- needing guest Git or guest-only configuration to reconstruct the environment declaration;
- needing a running daemon to discover which runtime generation the launcher should trust.

## Normal startup

Normal startup should conceptually be:

1. permanent entry resolves the locally selected runner channel/ref;
2. selector becomes one exact immutable runner subject;
3. verified runner is reused or acquired;
4. runner resolves/reconciles the accepted runtime;
5. runner transfers control to the exact accepted runtime;
6. runtime starts/reconciles required services;
7. services/runtime observe execution-environment readiness;
8. normal DevBridge work proceeds only when required boundaries are ready.

Fast normal startup should reuse already verified subjects and should not redownload/reinstall healthy layers on every invocation.

For a moving development selector, the exact subject selected for an invocation also bounds the control-plane tree used for that invocation. If the selector resolves to exact head X, ordinary runtime CLI commands execute from X, or from an explicitly accepted exact fallback for that same selector when refresh cannot proceed. The runner must not hand those commands to unrelated accepted-runtime history. Stage 0 remains bootstrap/recovery authority rather than the ordinary runtime CLI.

## Normal update

Normal application update should conceptually be:

1. currently accepted runtime remains authoritative;
2. exact candidate runtime is resolved and materialized separately;
3. integrity/compatibility and required candidate validation complete;
4. current services are cooperatively drained/fenced;
5. activation intent is durable before the switch;
6. exact candidate becomes current;
7. candidate health is verified;
8. last-known-good remains available until replacement health is established;
9. failed activation returns to or preserves the exact last-known-good generation where rollback is truthful;
10. ambiguous transition state is observed/reconciled rather than guessed.

Do not overwrite the live accepted runtime in place as the ordinary update mechanism.

## Setup and re-entry

Setup is owned by the accepted runtime, not the permanent entry.

The permanent entry and runner establish working DevBridge application software. The runtime then owns guided discovery and local authority decisions.

Setup should:

- discover first;
- recommend safe defaults second;
- prompt only for unresolved choices or explicit authority-bearing consent;
- persist its own versioned durable progress;
- survive elevation, reboot, sign-out/session refresh, image construction, provider configuration, and enrollment interruptions;
- support explicit re-entry later;
- never silently re-enter authority-changing setup from an ordinary runtime command.

Issue #116 and setup/reconfiguration issue #103 own this operator/setup layer.

## Uninstall versus purge

Application management must distinguish at least:

### Application/runtime replacement

Replace runner/runtime generations while preserving installation identity, operator configuration, and declared environments unless an explicit migration says otherwise.

### Application uninstall

Remove normal executable/runtime/service payloads according to declared uninstall policy while clearly reporting which durable configuration/environment state is preserved.

### Full purge

An explicitly destructive operation that may remove owned durable state according to an exact impact/ownership manifest.

Purge must never silently remove foreign/operator virtualization infrastructure.

If a purge intentionally removes user-approved authority/configuration, later recovery becomes a fresh/setup-reentry case; DevBridge must not invent the destroyed authority.

## Security boundary

Remote tasks, repository content, guest output, model output, dependencies, and web content cannot select:

- permanent-entry source or verification policy;
- stable runner release/source/signing policy;
- runtime release/signing policy;
- installation identity;
- configuration/authority values;
- provider objects;
- VM/domain/disk paths or names;
- privileged lifecycle helpers;
- destructive uninstall/purge targets.

Development/testing selectors are explicit local operator authority and must not weaken production stable verification.

No application-management failure may fall back to repository-controlled execution on the host.

## LEGO requirements

Each layer is a replaceable LEGO with a narrow local contract.

- The permanent-entry core names only selector, subject, provider/materialization, verification, and handoff concepts local to that layer.
- The runner/bootstrap manager names only runtime acquisition/selection/transition concepts local to that layer.
- The runtime consumes configuration and lifecycle studs without embedding permanent-entry implementation identities.
- Setup consumes local application/environment capabilities; it does not implement another runner or provider stack.
- Environment lifecycle consumes approved declaration/image/bootstrap/provider studs; it does not know how the permanent entry retrieves the runner.

Do not create convenience imports that make a higher-level recovery layer depend on the implementation it is supposed to replace.

## Required recovery classes

The application-management design must support and distinguish the following states.

### 1. Runner cache loss

Permanent entry survives; selected runner/cache is absent or corrupt.

Expected result: reacquire and verify the exact authorized runner, then continue.

### 2. Managed runtime loss

Permanent entry/runner and durable installation/configuration authority survive; accepted runtime files are absent or corrupt.

Expected result: runner reconstructs a verified runtime and returns the same logical installation to service without manual source checkout surgery.

### 3. Stale or incompatible accepted runtime

Accepted runtime exists but cannot perform the update needed to repair itself.

Expected result: permanent-entry/runner compatibility path stages and activates an independently verified suitable runtime without trusting the stale runtime to implement the repair.

### 4. Service loss

Runtime is intact but daemon/service state is absent or dead.

Expected result: runtime reconstructs/restarts services from durable state.

### 5. Execution-environment loss

Runtime is healthy but VM/domain/system disk/base-image cache/workspace materialization is absent or invalid.

Expected result: environment lifecycle acquires/reconstructs exact approved prerequisites and returns to DB-020 VM-only readiness.

### 6. Combined replaceable-state loss

Permanent entry and durable local authority survive, while runner cache, accepted runtime, services, VM/domain/system disk, local base-image cache, and guest/workspace materialization are absent.

Expected result:

```text
Permanent Entry
  -> reacquire Runner
  -> reconstruct Accepted Runtime
  -> restart Services
  -> reconstruct Base Image
  -> create/rebuild Execution Environment
  -> bootstrap/enroll Guest
  -> reseed Workspace Routes/State
  -> verify DB-020 readiness
```

No manual Git checkout, Hyper-V Manager, `virsh`, VHDX/qcow2 surgery, SSH-key placement, or guest OS installation should be required.

### 7. True fresh host / authority loss

Only the permanent entry/trust anchor is present, or operator configuration/authority was intentionally destroyed.

Expected result: permanent entry and runner restore working DevBridge software automatically, then the runtime enters supported guided setup/re-entry for authority that cannot safely be inferred.

DevBridge must not fabricate repository approvals, trusted actors, provider ownership, destructive policy, or similar lost authority.

## Final qualification

The complete application-management stack is not qualified solely by unit tests for individual layers.

Real Windows and Linux qualification must include a whole-stack canary that starts with:

- permanent entry installed and valid;
- durable local installation/configuration authority retained;
- no verified runner cache;
- no accepted managed runtime payload;
- no running DevBridge services;
- no DevBridge execution-profile VM/domain;
- no guest system/writable disk;
- no local cached base image;
- no guest workspace materialization.

The canary must prove, through supported DevBridge entry/setup/lifecycle surfaces only:

1. runner acquisition and verification;
2. managed runtime reconstruction and activation;
3. service startup;
4. preservation/recovery of installation identity and approved configuration;
5. exact base-image reacquisition/reconstruction;
6. provider environment construction;
7. unique guest/bridge enrollment;
8. bootstrap/tooling readiness;
9. repository workspace reconstruction from host-authoritative state;
10. final deterministic repository operation through DB-020 VM-only execution;
11. absence of direct-host repository fallback at every intermediate failure state.

A second fresh-host canary should remove operator configuration as well and prove that DevBridge reconstructs its application software but correctly stops at guided setup rather than inventing lost authority.

## Issue ownership

This document composes, rather than replaces, existing focused owners:

- #159 — permanent entry and runner selection/materialization boundary;
- #153 — runtime bootstrap compatibility/update escape path;
- DB-011 — runtime supervision, release integrity, activation, last-known-good/rollback;
- #103 / #116 — installation, guided setup, reconfiguration, repair, re-entry, uninstall;
- #169–#178 — reconstructable execution-environment lifecycle;
- #177 — provider/storage authority isolation;
- DB-009 — ambiguous-effect journaling/reconciliation;
- DB-018 — cooperative pause/fencing;
- DB-020 — VM-only repository execution boundary.

The whole-stack integration/qualification issue should remain an integration owner. It must not duplicate the implementations owned by these layers.
