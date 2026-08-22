# DevBridge documentation map

This directory is the maintained documentation entry point for DevBridge.

DevBridge has accumulated implementation plans, migration records, normative specifications, operator guides, and historical handoffs. They are all useful, but they do **not** all have the same authority. Start here instead of treating the newest-looking Markdown file or issue comment as current behavior.

## Start here

| Need | Read |
| --- | --- |
| Understand what DevBridge is | [`../README.md`](../README.md) |
| Understand install/update/runtime ownership | [`application-management.md`](application-management.md), [`application-management-decisions.md`](application-management-decisions.md), and [`application-recovery-matrix.md`](application-recovery-matrix.md) |
| Install or configure DevBridge | [`setup.md`](setup.md) |
| Operate an installed DevBridge | [`operations.md`](operations.md) |
| Diagnose a failure | [`troubleshooting.md`](troubleshooting.md) |
| Understand security and control flow | [`architecture.md`](architecture.md) |
| Understand engineering rules | [`design-principles.md`](design-principles.md) and [`../AGENTS.md`](../AGENTS.md) |
| Understand persistent VM/workspace ownership | [`execution-profile-environments.md`](execution-profile-environments.md) |
| Understand post-recovery CUDA/GPU direction | [`gpu-execution-profiles.md`](gpu-execution-profiles.md) |
| Understand Stage 0 and self-update | [`bootstrap.md`](bootstrap.md) and [`bootstrap-compatibility.md`](bootstrap-compatibility.md) |
| Understand current VM-program status | [`roadmap.md`](roadmap.md) |

## Current product model

The current architecture has two complementary views.

### Application-management hierarchy

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

Installation identity and operator configuration/authority are durable local control state stored separately from replaceable runner/runtime/service generations.

The governing replaceability rule is:

> Each layer may reconstruct or replace the layer immediately below it. No lower layer may be the only authority required to reconstruct its owner.

See [`application-management.md`](application-management.md) for ownership, [`application-recovery-matrix.md`](application-recovery-matrix.md) for zero-state recovery qualification, and [`application-management-decisions.md`](application-management-decisions.md) for the decisions agents must preserve.

### Repository execution hierarchy

```text
remote request / controller
        |
        v
trusted DevBridge host control plane
        |
        +-- authoritative Git / provenance / policy / leases / verification / publication
        |
        v
execution-profile router
        |
        v
persistent untrusted VM
        |
        v
repository workspace
```

The important current rules are:

- repository-controlled execution is **VM-only**;
- Windows uses Hyper-V and Linux uses KVM/QEMU through libvirt as the initial provider families;
- execution profiles own physical persistent VMs;
- repositories own isolated workspaces inside compatible profile VMs;
- authoritative Git, credentials, publication state, provider authority, runtime-supervision state, and other machine authority stay on the host;
- guest output, model output, repository content, and remote task text are data/proposals, not authority;
- missing or unready VM execution fails closed rather than falling back to direct host execution;
- the persistent installed DevBridge and disposable test installations are different installations and should be distinguished by their stable `DB-<12 hex>` installation tags.

GPU-capable profiles remain a future specialization of this same model. They are intentionally sequenced after installer/runtime recovery and reconstructable VM lifecycle work. A GPU profile must use the same create/rebuild/setup/provider ownership surfaces rather than becoming a parallel provisioning stack.

## Identity vocabulary

Several independent identities are intentionally present. Do not collapse them into one "version" concept.

| Identity | Meaning | Example |
| --- | --- | --- |
| Installation tag | Which local DevBridge installation is this? | `DB-7A41C0E25F19` |
| Runner subject | Which exact bootstrap-manager generation did the permanent entry select? | exact immutable subject + digest |
| Runtime head | Which exact DevBridge code is accepted for that installation? | 40-hex Git commit |
| Activation state | Is the accepted runtime healthy, rolled back, etc.? | `healthy` |
| Supervisor/daemon generation | Which live local owner/process generation is authoritative? | local bounded generation record |
| Execution profile | Which materially distinct execution platform is selected? | `windows`, `linux`, future GPU variants |
| Repository workspace | Which repository-local workspace inside the profile VM? | deterministic repository+profile identity |
| Run/task identity | Which bounded work transaction is active? | DevBridge run identity |

The installation tag is stable across runner/runtime updates. Two different installation homes get different tags even when they run the same runtime head.

See [`operations.md`](operations.md) for operator use of these identities.

## Normative specifications

`specs/DB-001` through `specs/DB-020` are the live normative contracts unless a newer specification explicitly supersedes an older statement.

The most commonly needed specifications are:

- DB-003 — capability/security boundary;
- DB-007 — human checkpoints;
- DB-009 — durable effects/reconciliation;
- DB-011 — runtime supervision/update/rollback;
- DB-013 — deterministic controller plans;
- DB-014 — context handoff/recovery;
- DB-016 — multi-agent identity/leases/fencing;
- DB-017 — baseline drift/publication reverification;
- DB-018 — workstation resource governance/pause;
- DB-019 — verification cost, timing, and evidence;
- DB-020 — VM-only repository-execution boundary.

Documentation explains those contracts. It does not silently weaken them.

## Architecture and implementation guides

These documents describe current implementation structure and intended operator behavior:

- [`application-management.md`](application-management.md) — permanent entry, runner, accepted runtime, services, execution environments, state separation, and whole-stack management lifecycle.
- [`application-recovery-matrix.md`](application-recovery-matrix.md) — exact loss/recovery ownership matrix and configured/fresh-host zero-state canaries.
- [`application-management-decisions.md`](application-management-decisions.md) — compact architectural decisions that prevent application-management layer drift.
- [`architecture.md`](architecture.md) — authority hierarchy, trust domains, provider-neutral flow, Git/source/candidate model.
- [`execution-profile-environments.md`](execution-profile-environments.md) — physical profile VM ownership and repository workspace routing.
- [`gpu-execution-profiles.md`](gpu-execution-profiles.md) — recovery-first real-CUDA/GPU sequencing, capability/evidence boundaries, and follow-on generalized compute routing.
- [`tool-profiles.md`](tool-profiles.md) — tool/profile surface and execution policy.
- [`bootstrap.md`](bootstrap.md) — standalone launcher and secure-bootstrap flow.
- [`bootstrap-compatibility.md`](bootstrap-compatibility.md) — Stage-0 protocol compatibility, accepted-runtime selection, installation tags, one-time legacy migration.
- [`setup.md`](setup.md) — installation and discover-first setup direction.
- [`roadmap.md`](roadmap.md) — current implementation/qualification stages.

## Migration and stage records

Files named `vm-stage*.md`, [`vm-migration.md`](vm-migration.md), and [`vm-lego-studs.md`](vm-lego-studs.md) are useful implementation evidence.

Read them with these rules:

1. a completed stage document may describe a topology that was later corrected;
2. current architecture/specification text wins over historical stage assumptions;
3. repository-owned persistent-VM language is historical where it conflicts with the current execution-profile ownership rule;
4. old host-sandbox behavior is historical evidence, not an available fallback.

## Handoffs, audits, and testing records

`docs/handoffs/` and point-in-time audit/testing records preserve context and evidence. They are deliberately retained for recovery and provenance.

They are **not** live configuration or product authority. A historical instruction such as a temporary branch restriction, migration workaround, or campaign-specific tool prohibition does not override current specifications, current repository state, or current operator instructions.

## Documentation maintenance rules

When behavior changes:

1. update the owning normative spec when the contract changes;
2. update the operator-facing guide when commands, status, recovery, or failure semantics change;
3. update architecture docs when ownership/topology changes;
4. mark superseded historical material instead of rewriting history;
5. keep examples path-free and secret-free unless a local path is essential to the operator action;
6. distinguish **configured**, **observed**, **ready**, **accepted**, and **healthy** states instead of using a generic "enabled" label;
7. distinguish installation identity from runner/runtime/version identity;
8. preserve the application-management hierarchy: Permanent Entry -> Runner -> Accepted Runtime -> Services -> Declared Execution Environments;
9. do not document a direct-host repository-code fallback—there is none.

The goal is that an operator or a fresh agent can answer three questions without reading issue history:

- What owns this behavior?
- What evidence proves its current state?
- What is the next safe action if it fails?
