# DB-011A — Recovery Bootstrap Control Plane

Status: active normative amendment to DB-011

This document is part of the DB-011 runtime-supervision contract. It resolves the zero-state bootstrap case where DB-011 candidate validation requires DB-020 VM execution but the candidate-validation environment itself is absent and no Accepted Runtime exists to reconstruct it.

Where this amendment is more specific than DB-011 for this recovery class, this amendment controls. It does not weaken DB-011's normal candidate-validation, release-integrity, activation, or last-known-good requirements.

## Problem

Normal DB-011 admission requires an executable DevBridge runtime candidate to complete candidate-controlled preflight/tests through the DB-020 VM execution boundary before activation.

The application-management architecture normally delegates execution-environment construction to the Accepted Runtime.

If both are absent, a circular dependency exists:

```text
no candidate-validation environment
  -> candidate cannot be DB-020 validated
  -> candidate cannot become Accepted Runtime
  -> no Accepted Runtime exists to reconstruct validation environment
```

The absence of a validation VM is not authority to execute candidate code directly on the host.

## Recovery Control Plane

A narrowly scoped Recovery Control Plane (RCP) breaks this cycle.

The RCP is a short-lived trusted bootstrap composition selected and verified by the Runner independently of the runtime candidate.

It is not:

- the Permanent Entry;
- the Runner;
- an Accepted Runtime;
- a normal daemon/service;
- a second environment/provider implementation;
- a host fallback for candidate or repository execution.

Its only purpose is to restore the prerequisites for normal DB-011 candidate acceptance, complete that acceptance, and terminate.

## Admission authority

The Runner may execute an RCP only when local/static recovery policy resolves one exact immutable recovery subject.

Production recovery subjects MUST bind at least:

- recovery protocol/version;
- exact immutable artifact identity;
- exact artifact SHA-256;
- minimum Permanent Entry/Runner protocol;
- release/channel identity;
- production signature and trusted key identity.

Development/testing recovery MAY use an explicit locally selected development policy, but a moving branch/ref MUST resolve once to an exact immutable subject before execution.

Remote task/feedback/decision text, repository content, model output, guest state/output, the runtime candidate, and mutable runtime branch movement MUST NOT select or alter RCP source, subject, executable identity, signing policy, provider, validation declaration, or recovery policy.

A failed/ambiguous RCP refresh MUST preserve the previous verified RCP subject when local policy permits LKG use; it MUST NOT execute unverified replacement bytes.

## Candidate remains untrusted

RCP admission does not grant trust to the runtime candidate.

Before DB-020 validation succeeds, the RCP MUST NOT import candidate modules or execute candidate code on the host.

Host-side candidate work before VM validation is limited to fixed/control-owned operations including:

- release-subject parsing;
- signature verification;
- fixed repository/origin/head/version checks;
- Stage-0/Runner compatibility checks;
- deterministic artifact digest computation;
- immutable artifact materialization;
- transfer preparation;
- neutral environment-lifecycle orchestration through trusted adapters.

The exact candidate artifact MUST be transferred into the validation VM as untrusted executable input. Candidate identity MUST be recomputed/rechecked after validation before activation.

A production signature is necessary release-integrity evidence but is not a substitute for DB-020 candidate validation.

## RCP capability boundary

The RCP MAY:

1. read bounded durable installation/recovery state through local trusted ports;
2. resolve one exact runtime candidate under DB-011 release policy;
3. perform candidate static integrity/compatibility verification;
4. observe the host-authoritative candidate-validation environment declaration;
5. call the #178 exact-image availability capability;
6. call shared resource/provider preflight;
7. call the same neutral #171 construction pipeline used by normal environment creation;
8. call the DB-020 candidate-validation capability for the exact candidate;
9. re-check candidate artifact identity after validation;
10. call DB-011 activation/LKG transition capabilities for that exact validated candidate;
11. observe bounded post-activation health needed for ownership handoff;
12. terminate after a healthy Accepted Runtime becomes authoritative.

The RCP MUST NOT:

- poll or claim repository tasks;
- execute ordinary repository work;
- invoke coding/model adapters;
- expose raw shell/argv authority;
- author/publish repository Git state;
- mutate GitHub task/decision/publication state;
- perform general-purpose setup/reconfiguration;
- create arbitrary repository workspaces;
- accept raw provider object names, provider paths, VM/domain names, disk paths, XML, QEMU argv, or PowerShell snippets;
- implement provider lifecycle mechanics already owned by environment/provider adapters;
- remain as a competing long-lived daemon after Accepted Runtime handoff.

## Validation-environment authority

The candidate-validation environment is host-authoritative desired state.

Its declaration, image subject, resource requirements, provider policy, bootstrap requirements, and bridge/workspace requirements cannot come from the candidate runtime or remote task content.

RCP reconstruction MUST route through the same neutral environment lifecycle used elsewhere:

```text
exact declaration
  -> exact image availability (#178)
  -> resource/provider preflight
  -> shared construction (#171)
  -> bridge/bootstrap readiness
  -> DB-020 candidate-validation route
```

The environment lifecycle core MUST remain caller-neutral. RCP use is temporary composition, not permission for lifecycle internals to name runtime-recovery concepts.

Hyper-V/libvirt/QEMU/VHDX/qcow2/PowerShell/XML/provider-specific identities terminate inside provider-local adapters.

If the validation declaration or provider/image authority is missing, contradictory, ambiguous, corrupt, or requires operator setup that cannot be inferred, RCP recovery MUST stop with bounded setup/operator guidance. It MUST NOT invent replacement authority from provider residue.

## Entry conditions

A healthy compatible Accepted Runtime remains the normal DB-011 update owner. RCP is not part of ordinary startup/update.

RCP MAY be entered only for a locally classified recovery condition such as:

- Accepted Runtime payload is absent/corrupt and runtime acceptance is blocked because the validation environment is absent/unready;
- an accepted runtime is too stale to implement the required compatibility transition and validation prerequisites must first be reconstructed independently;
- a prior RCP transition was interrupted and an exact durable recovery journal requires reconciliation.

The Runner MUST prefer normal accepted-runtime behavior when it is healthy, compatible, and capable of completing DB-011 update semantics.

## Durable recovery journal

RCP recovery follows DB-009.

Before each consequential effect, durable intent/evidence MUST bind enough identity to reconcile rather than blindly repeat the effect.

The recovery journal MUST bind at least:

- exact RCP subject;
- exact runtime candidate subject;
- static candidate-verification evidence;
- exact validation-environment declaration revision;
- exact image subject/acquisition state;
- environment construction action identities and implementation generation;
- exact candidate-validation evidence identity;
- activation predecessor/current/candidate identity;
- post-activation health/handoff state;
- RCP terminal/exit state.

On restart the RCP/Runner MUST observe current state before replay. Loss of the original process does not prove that image publication, provider creation, candidate execution, activation, or handoff did not occur.

Ambiguous state fails closed until it is reconciled or an exact operator/setup action is required.

## Ownership and exclusivity

RCP MUST participate in the same installation-wide ownership/fencing model as DB-011 activation and DB-018 cooperative control.

It MUST NOT race a healthy Accepted Runtime or another RCP for home-wide runtime activation state or provider lifecycle state.

If an old Accepted Runtime remains live, any transition requiring shared lifecycle/activation state MUST use the existing token/generation-bound cooperative pause/drain semantics. Unknown ownership or PID/token reuse ambiguity fails closed.

After a healthy Accepted Runtime owns the installation, RCP MUST terminate and release its recovery ownership. It MUST retain no independent daemon authority.

## Activation

RCP does not define a new activation mechanism.

After exact DB-020 candidate validation and post-validation artifact identity confirmation, activation uses existing DB-011 current/candidate/LKG semantics:

1. persist exact activation intent;
2. preserve truthful current/LKG state where one exists;
3. activate only the exact validated candidate artifact;
4. start the candidate through the normal accepted-runtime entry contract;
5. require bounded post-activation health/doctor evidence;
6. record healthy accepted state only after those checks pass;
7. restore/retain exact LKG on activation/health failure where rollback is truthful;
8. stop on unresolved activation/rollback ambiguity rather than broadening authority.

## Zero-state sequence

For a configured installation where Permanent Entry and durable local authority survive but Runner cache, Accepted Runtime, validation VM, normal profile VMs, services, and local image cache are absent:

1. Permanent Entry resolves/acquires/verifies Runner.
2. Runner resolves exact runtime release subject and observes that DB-011 validation cannot currently run.
3. Runner resolves/acquires/verifies RCP.
4. RCP statically verifies the exact runtime candidate without importing it.
5. RCP reconstructs the exact validation image/environment through #178/#171.
6. RCP transfers and validates the exact candidate through DB-020.
7. RCP rechecks exact candidate artifact identity.
8. RCP invokes DB-011 activation/LKG transition.
9. candidate becomes Accepted Runtime only after required health evidence.
10. RCP terminates.
11. Accepted Runtime recreates normal services and declared execution environments.
12. final repository execution remains DB-020 VM-only.

## Authority loss

If durable local recovery/runtime/provider/environment authority was intentionally purged, automatic recovery stops at the highest layer whose authority remains provable.

RCP MUST NOT infer lost authority from:

- VM/domain/disk names;
- filenames/paths;
- guest Git/configuration;
- cached provider output;
- issue/chat history;
- repository residue;
- mutable branch names.

Where a trusted runtime can still be established by independent local bootstrap policy, the resulting Accepted Runtime may enter guided setup/re-entry. Otherwise the operator must restore the missing trust/configuration anchor explicitly.

## Required tests

Tests MUST cover at least:

- normal healthy runtime path does not invoke RCP;
- absent runtime + ready validation environment still uses normal DB-011 candidate validation without provider-specific RCP branching;
- absent runtime + absent validation environment invokes exact verified RCP;
- corrupt/mismatched/unsigned RCP subject fails before RCP execution;
- remote/repository/model/candidate inputs cannot select RCP source/ref/key/provider/declaration;
- RCP source contains no concrete provider/repository/task/model identities;
- RCP cannot invoke candidate code on host before DB-020 validation;
- missing/corrupt local image routes through #178 before provider allocation;
- missing validation VM routes through #171 shared construction and creates one exact implementation generation;
- interruption after image acquisition, provider creation, guest enrollment, validation, activation intent, activation, and handoff reconciles exact durable state;
- duplicate process/restart cannot create a second validation VM or repeat an ambiguous candidate effect;
- candidate mutation after validation fails before activation;
- failed candidate validation never activates candidate;
- failed activation/health preserves/restores exact LKG when available;
- RCP exits after healthy Accepted Runtime handoff;
- Windows real-host recovery reaches a VM-validated Accepted Runtime through Hyper-V from no runtime/no validation VM/no local image cache;
- Linux real-host recovery reaches a VM-validated Accepted Runtime through KVM/QEMU/libvirt from the equivalent zero state;
- no failure mode enables direct-host candidate or repository execution.

## Coordination

- Issue #182 is the implementation/qualification owner for this amendment.
- Issue #180 owns whole-stack composition.
- Issue #159 owns Permanent Entry/Runner selection and verified RCP handoff.
- Issue #153 remains the stale-runtime compatibility defect owner.
- #169/#171/#178 own the shared reconstructable environment/image pipeline.
- DB-009 governs durable effect reconciliation.
- DB-018 governs cooperative ownership/pause boundaries.
- DB-020 remains the candidate/repository execution boundary.
- #116/#176 own setup/re-entry when local authority cannot be reconstructed automatically.
