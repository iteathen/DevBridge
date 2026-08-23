# Shared environment construction

Issue #171 builds one restartable construction LEGO on top of #170 desired-state authority and #178 exact-image availability.

## Core boundary

The construction core knows only neutral ports:

- `image.ensure`
- `resources.ensure`
- `materialization.ensure`
- `preparation.ensure`
- `workspaces.ensure`
- `readiness.verify`
- lifecycle declaration/journal and an exclusive fence

It does not know virtualization providers, disk formats or paths, guest access mechanisms, repository implementations, network object names, image transports, or command lines. Composition adapters translate the declaration's neutral requirement identities to their locally owned mechanisms.

## Restartable pipeline

The shared stages are:

`image -> resources -> materialization -> preparation -> workspaces -> readiness`

A separate bounded construction checkpoint stores only the logical environment identity, outer lifecycle operation identity, declaration revision, contiguous completed stages, current implementation generation, and final neutral readiness observation. Each port is an observe/ensure contract and must be idempotent for the exact declaration + operation subject. If the process stops after an external effect but before a checkpoint write, repeating that port must reconcile the exact effect rather than blindly create another one.

`create`, rebuild, reset, and later recreate consume this same pipeline. They do not own independent provider provisioning stacks.

## Create

`create` is locally authorized against one persisted declaration. It refuses to create without a declaration and refuses any pre-observation other than `materialization-not-created`. It records the #170 lifecycle intent and pre-observation, acquires an exclusive logical fence, runs/resumes the shared pipeline, records post-observation, independently re-verifies healthy readiness, clears only the exact construction checkpoint, and terminates the lifecycle journal.

A failed/interrupted create leaves the outer lifecycle journal and fine-grained construction checkpoint available for exact resume. Re-entry verifies the same declaration revision and reacquires the same logical fence subject before continuing. A changed fence subject, declaration revision, implementation generation, image subject, or readiness observation fails closed rather than broadening authority.

## Rebuild consumption

#173 reuses this pipeline after diagnosis has selected rebuild for missing or invalid replaceable system storage. The lifecycle owner, not the construction pipeline, must first prove the exact current implementation exists and is owned. Storage-health evidence may select rebuild only after that ownership proof; provider-local reason text is never ownership authority.

Once fenced, rebuild assigns one planned replacement implementation generation and passes that generation through this same pipeline. `image.ensure` therefore reacquires the exact declared image through #178 when necessary before materialization. `materialization.ensure` creates or reconciles the planned replacement without requiring the superseded system disk. `preparation.ensure` establishes fresh implementation-local bootstrap/enrollment identity. `workspaces.ensure` reseeds from host-authoritative registrations. `readiness.verify` qualifies the replacement independently before lifecycle completion.

The construction checkpoint remains keyed to the outer lifecycle operation, so an interruption after an external replacement effect resumes the same generation rather than allocating another. Cleanup of a damaged superseded generation is deliberately outside construction; rebuild retains it unless a separate exact-owned cleanup decision proves removal safe.

## Reset consumption

#174 uses the same pipeline only after a read-only profile-wide impact preview has been locally authorized against the exact current implementation generation. The generic construction pipeline does not know that the caller is destructive and does not own authorization.

The reset materialization adapter consumes a request-bound staged replacement stud from the persistent-environment owner. It must be attached to the exact active outer `reset` journal entry and passes that outer operation identity through as the replacement idempotency subject. The previous generation is taken from the reset journal's pre-observation; repository or workspace input cannot substitute another provider target.

For reset:

1. `image.ensure` verifies/reacquires the exact declared clean base image;
2. `resources.ensure` proves replacement capacity before provider materialization;
3. `materialization.ensure` creates/reconciles one new implementation generation and switches current authority while retaining the exact superseded generation;
4. `preparation.ensure` reconstructs implementation-local bootstrap/enrollment state;
5. `workspaces.ensure` reseeds **every registered profile workspace** from its host-authoritative registration;
6. `readiness.verify` qualifies the new clean baseline;
7. the outer reset independently re-verifies the exact resulting generation;
8. only after verification does the reset retirement adapter remove the exact retained superseded history generation.

Retirement is deliberately outside the construction pipeline. A construction failure therefore leaves the superseded generation retained rather than treating provider-level replacement as sufficient proof that the new profile is ready. If retirement itself is interrupted, the reset journal remains at verification and the exact retirement effect is reconciled on resume.

A lost response after replacement does not authorize another generation. Re-entry reruns the same construction stage, whose reset materialization adapter delegates to the request-bound replacement owner. That owner may reconcile only the same planned outer operation/previous-generation pair.

Workspace-local reset remains a separate narrower operation. It does not use the profile-reset materialization adapter and cannot broaden its authority into replacing the profile environment.

## Preparation ownership

Construction passes the declared boot, enrollment, and bootstrap requirements but does not interpret them. The preparation owner must establish a unique implementation identity/trust subject and bootstrap/tooling readiness before returning `ready`. Provider/guest-specific mechanics remain outside this core.

## Qualification

The code-level construction contract is qualified across every durable stage: interruption at image, resource preflight, materialization, preparation, workspace materialization, or readiness resumes from the exact contiguous checkpoint without replaying already completed stages. Tests also cover exact-image unavailability, provider/storage/network prerequisite blockers, implementation-generation drift, fence-subject drift during create resume, post-construction generation substitution, missing declaration/setup re-entry, and overwrite refusal.

#173 adds rebuild qualification around the same contract: missing/invalid storage diagnosis must not bypass ownership proof, the planned replacement generation must remain stable across interruption, and old damaged state must not be required for reconstruction.

#174 adds reset qualification around that contract: the impact preview enumerates all affected workspaces/state classes, protected state and resource blockers prevent mutation, local approval binds the exact impact digest/current generation, replacement is request-bound and restartable, the old generation remains retained until readiness verification, and retirement can target only the exact superseded history generation.

Hosted CI proves the neutral orchestration and fail-closed contracts on Windows and Linux runners. Real Hyper-V and KVM/libvirt create/rebuild/reset fault canaries remain provider-hardware qualification owned with #115/#116 and are not represented as proven by hosted CI.
