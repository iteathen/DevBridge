# DevBridge recovery control plane

## Purpose

DevBridge normally starts through the application-management hierarchy:

```text
Permanent DevBridge Entry
  -> Runner / Bootstrap Manager
  -> Accepted DevBridge Runtime
  -> DevBridge Services
  -> Declared Execution Environments
```

That normal hierarchy has one zero-state bootstrap hazard: DB-011 requires candidate-controlled runtime validation to occur through DB-020 VM execution before the candidate becomes the Accepted Runtime, while the VM construction lifecycle is normally invoked by an already accepted runtime.

When both the managed runtime and candidate-validation environment are absent, those two requirements form a cycle.

Issue #182 owns the narrow bridge that breaks the cycle without weakening DB-011 and without teaching the Permanent Entry or Runner how to provision Hyper-V/libvirt directly.

## Recovery path

The exceptional zero-state path is:

```text
Permanent Entry
  -> verified Runner
  -> verified Recovery Control Plane
  -> reconstruct candidate-validation environment
  -> DB-020 validate exact runtime candidate
  -> activate exact Accepted Runtime
  -> Recovery Control Plane exits
  -> Accepted Runtime recreates normal Services / declared environments
```

The Recovery Control Plane is not a sixth long-lived application layer. It is a short-lived bootstrap composition used only when the normal runtime-acceptance path cannot proceed because its validation environment is absent or unreconstructable by a healthy Accepted Runtime.

## Core rule

> The recovery bridge may temporarily compose existing neutral lifecycle, validation, and activation studs. It must not duplicate their mechanics or broaden authority.

The Recovery Control Plane therefore has no independent Hyper-V, libvirt, image, workspace, runtime-update, repository, or model implementation.

## Admission and trust

The Recovery Control Plane executes trusted host-control operations before an Accepted Runtime exists. Its own admission must therefore be independent of the candidate runtime it is helping to validate.

The Runner may launch a Recovery Control Plane only from local/static recovery policy bound to one exact immutable recovery subject.

A production recovery subject binds at least:

- recovery protocol/version;
- exact immutable artifact identity;
- artifact SHA-256;
- minimum Permanent Entry/Runner protocol;
- release/channel identity;
- production signature/key identity.

Mutable branch movement is never recovery-runtime identity. A development selector may resolve once to an exact immutable subject under explicit local development policy, but remote input cannot select or alter it.

The following cannot select recovery source, subject, executable, key, policy, or provider target:

- repository content;
- task/issue/comment text;
- model output;
- guest output/state;
- the candidate runtime;
- mutable runtime branch state.

## Capability surface

The Recovery Control Plane may only perform the bounded control work necessary to reach normal Accepted Runtime ownership.

It may:

1. read bounded durable installation/recovery state through local ports;
2. resolve one exact runtime candidate subject under DB-011 release policy;
3. perform candidate static verification without importing candidate modules;
4. observe the host-authoritative candidate-validation environment declaration;
5. ensure its exact image through #178;
6. invoke the same source-neutral resource and #171 construction lifecycle used by normal environment creation;
7. invoke the existing DB-020 candidate-validation capability against the exact candidate;
8. re-check the candidate artifact identity after validation;
9. invoke DB-011 activation/LKG transition capabilities for that exact validated candidate;
10. verify bounded runtime health/handoff state;
11. terminate after ownership transfers to the healthy Accepted Runtime.

It must not expose or perform:

- repository task polling or ordinary task execution;
- coding/model adapters;
- arbitrary shell/argv execution;
- Git authoring or publication;
- GitHub task/decision mutation;
- general setup/reconfiguration;
- arbitrary repository workspace provisioning;
- raw provider object names, paths, commands, XML, PowerShell, VHDX, or qcow2 topology;
- a persistent daemon competing with the Accepted Runtime.

## Candidate runtime remains untrusted until DB-020 validation

The Recovery Control Plane does not create an exception that allows candidate runtime code to execute directly on the host before acceptance.

Before DB-020 candidate validation succeeds, host-side work is limited to control-owned parsing, signature/digest/origin/head/version/compatibility checks, immutable artifact handling, neutral lifecycle orchestration, and provider adapters already trusted by the recovery subject.

The candidate runtime is transferred into the reconstructed validation VM as untrusted executable input. The exact artifact is rechecked after validation before activation.

A production signature remains necessary but does not replace VM candidate validation.

## Candidate-validation environment

The validation environment is host-authoritative desired state. It is not selected by repository/task/model input.

Its reconstruction uses the same environment lifecycle that normal runtime code uses:

```text
exact desired declaration
  -> #178 exact image availability
  -> resource/provider preflight
  -> #171 shared construction pipeline
  -> bridge/bootstrap readiness
  -> candidate-validation route ready
```

The Recovery Control Plane may call that neutral construction LEGO before the Accepted Runtime exists. This is caller substitution at composition time, not lifecycle ownership leakage.

The lifecycle core must therefore remain caller-neutral: it knows declarations, observations, resources, materialization, preparation, workspaces, and readiness; it does not know whether its current caller is the normal runtime, setup, or recovery composition.

Provider identities remain wholly inside their adapters.

## Authority-loss behavior

Automatic recovery requires enough surviving local authority to identify the validation declaration, image subject, provider policy, recovery subject, and runtime release policy.

If those records were intentionally purged or are ambiguous/corrupt, the Recovery Control Plane stops.

It must not reconstruct authority from:

- VM/domain/disk names;
- old paths;
- guest Git;
- repository residue;
- issue/chat history;
- cached provider output;
- mutable branch names.

When the application software can be restored but local authority cannot, the supported result is guided setup/re-entry after a trusted runtime can be established by the supported bootstrap policy. No lost authority is guessed.

## Normal-path invariant

A healthy compatible Accepted Runtime remains the normal DB-011 update owner.

The Recovery Control Plane is not entered merely because an update exists. It is entered only for an exact locally classified recovery condition where normal runtime acceptance cannot proceed, including:

- Accepted Runtime payload absent/corrupt and candidate validation cannot run because its environment is absent;
- accepted runtime too stale to perform the required compatibility transition and the validation environment must first be reconstructed;
- interrupted recovery with an exact durable recovery journal requiring reconciliation.

When normal runtime update can proceed, the Recovery Control Plane is not launched.

## Recovery state machine

Recovery follows DB-009, not generic retry.

Durable recovery state binds at least:

1. exact recovery subject;
2. exact runtime candidate subject;
3. candidate static-verification evidence;
4. validation-environment declaration revision;
5. exact image subject/availability evidence;
6. construction action identities and implementation generation;
7. candidate-validation evidence identity;
8. activation predecessor/candidate identity;
9. post-activation health/handoff state;
10. recovery-control termination state.

On restart, each stage is re-observed and reconciled before repeating an effect. A missing process does not imply that VM creation, image publication, candidate execution, or activation failed or never occurred.

## Ownership and LEGO constraints

### Permanent Entry

Still owns only:

```text
local selector -> exact verified Runner -> argv handoff
```

It does not learn recovery lifecycle/provider details.

### Runner

May resolve/verify and launch a recovery subject under local policy. It does not acquire provider-specific management logic or repository behavior.

### Recovery Control Plane

Owns only the exceptional orchestration topology and its recovery journal. Its inputs/outputs remain neutral.

### Environment lifecycle

Remains the same #169/#171/#178 implementation used by normal runtime/setup. It does not know runtime recovery exists.

### Candidate validation

Remains DB-020 VM-only. No direct-host candidate fallback is introduced.

### Provider adapters

Remain unaware of runtime/recovery/repository identities.

If the recovery bridge requires copying an adjacent module's implementation or naming its concrete objects internally, repair the stud instead.

## Whole-stack recovery sequence

With Permanent Entry plus durable local authority surviving, but Runner cache, Accepted Runtime, services, validation environment, normal profile VMs, and image cache absent:

1. Permanent Entry reacquires/verifies Runner.
2. Runner observes that no usable Accepted Runtime path can satisfy candidate validation.
3. Runner resolves/verifies Recovery Control Plane.
4. Recovery Control Plane resolves/statically verifies exact runtime candidate.
5. Recovery Control Plane reconstructs only the required candidate-validation environment through #178/#171.
6. Exact candidate runs validation through DB-020.
7. Candidate artifact identity is rechecked.
8. DB-011 activation transitions to the exact validated candidate.
9. Accepted Runtime health is established.
10. Recovery Control Plane exits.
11. Accepted Runtime recreates its normal services and required declared execution environments.
12. Final repository canary executes through DB-020.

This order removes the circular dependency while preserving both VM-only candidate validation and the normal application-management hierarchy after recovery.

## Qualification

Issue #182 cannot close without real-host qualification on both initial provider families.

Windows canary:

- Permanent Entry and durable authority survive;
- managed runtime absent;
- candidate-validation VM/system disk absent;
- local validation base-image cache absent;
- recovery reaches a DB-020-validated Accepted Runtime through Hyper-V;
- normal Accepted Runtime then reconstructs the required profile environment.

Linux canary:

- same loss profile;
- recovery reaches a DB-020-validated Accepted Runtime through KVM/QEMU/libvirt;
- normal Accepted Runtime then reconstructs the required profile environment.

At every intermediate failure state, repository-controlled and candidate-controlled code remain unavailable rather than executing directly on the host.

## Related authority

- #182 — implementation and qualification owner for this bridge.
- #180 — whole-stack application-management integration owner.
- #159 — Permanent Entry / Runner selection and verified handoff.
- #153 / DB-011 — stale-runtime escape path, candidate validation, activation, LKG.
- #169/#171/#178 — reconstructable environment lifecycle and exact image availability.
- DB-009 — durable effects/reconciliation.
- DB-020 — VM-only candidate/repository execution.
- #116/#176 — setup/re-entry when durable local authority is missing or requires operator action.
