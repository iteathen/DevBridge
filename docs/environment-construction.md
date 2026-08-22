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

`create`, and later rebuild/reset/recreate, consume this same pipeline. They do not own independent provider provisioning stacks.

## Create

`create` is locally authorized against one persisted declaration. It refuses to create without a declaration and refuses any pre-observation other than `materialization-not-created`. It records the #170 lifecycle intent and pre-observation, acquires an exclusive logical fence, runs/resumes the shared pipeline, records post-observation, independently re-verifies healthy readiness, clears only the exact construction checkpoint, and terminates the lifecycle journal.

A failed/interrupted create leaves the outer lifecycle journal and fine-grained construction checkpoint available for exact resume. Re-entry verifies the same declaration revision and reacquires the same logical fence subject before continuing. A changed fence subject, declaration revision, implementation generation, image subject, or readiness observation fails closed rather than broadening authority.

## Preparation ownership

Construction passes the declared boot, enrollment, and bootstrap requirements but does not interpret them. The preparation owner must establish a unique implementation identity/trust subject and bootstrap/tooling readiness before returning `ready`. Provider/guest-specific mechanics remain outside this core.

## Qualification

The code-level construction contract is qualified across every durable stage: interruption at image, resource preflight, materialization, preparation, workspace materialization, or readiness resumes from the exact contiguous checkpoint without replaying already completed stages. Tests also cover exact-image unavailability, provider/storage/network prerequisite blockers, implementation-generation drift, fence-subject drift during create resume, post-construction generation substitution, missing declaration/setup re-entry, and overwrite refusal.

Hosted CI proves the neutral orchestration and fail-closed contracts on Windows and Linux runners. Real Hyper-V and KVM/libvirt fresh-create/fault canaries remain provider-hardware qualification owned with #115/#116 and are not represented as proven by hosted CI.
