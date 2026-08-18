# PP-001 — System Contract

Status: active

## Goal

Provide a durable bridge between trusted GitHub-issued coding tasks and a locally controlled development environment without making GitHub, a coding model, repository content, or human-authored remote text the security authority for the machine.

## Control-plane authority

PATCH-POLLER owns authoritative run state, Git workspace ownership, capability policy, publication state, and lifecycle transitions.

Remote and local LLMs are subordinate proposal engines. They may propose patches, commands through locally defined tool profiles, repairs, explanations, next steps, or architectural directions. PATCH-POLLER validates, accepts, defers, or discards those proposals. A model does not become authoritative because it is local, trusted by a user, or produced a previously successful result.

Human decisions are also interpreted through PATCH-POLLER's locally configured policy. A trusted maintainer can decide only the decision classes local policy assigns to that actor; remote text cannot create new machine authority.

## Required ports

The application layer depends on narrow contracts for:

- `TaskSource`: discover task revisions.
- `StatusSink`: publish coalesced progress, checkpoints, feedback requests, and terminal handoffs.
- `FeedbackSource`: receive trusted continuation/cancel feedback and checkpoint decisions.
- `CredentialProvider`: provide GitHub credentials only to adapters that explicitly require them.
- `StateStore`: persist restart-critical state atomically.
- `WorkspaceManager`: map repository identity to managed local workspace and provision safely.
- `ToolRunner`: run a locally configured coding tool under a declared containment contract.
- `Clock`: make polling/backoff behavior testable.
- `Logger`: bounded local observability.

Adapters may be replaced independently. Application logic must not depend on GitHub issue JSON shapes or Node child-process details.

Human checkpoint policy is application/control-plane logic, not a property delegated to a coding model or transport adapter.

## Run lifecycle

A run uses explicit primary states:

`discovered -> validated -> claimed -> preparing -> running -> verifying -> reporting -> completed`

Terminal alternatives are `failed` and `cancelled`. `blocked` is reserved for a genuine inability to proceed safely, not merely for the existence of a pending human question.

Human-attention state is orthogonal to the primary lifecycle. A run may be `running` or `verifying` while also being `checkpointed`, `decision-pending`, or `hard-gate-pending` under PP-007.

`waiting-decision` is a resumable non-terminal condition used only when the safe/reversible work frontier is exhausted or the next required effect is hard-gated.

State transitions are persisted before irreversible or externally visible follow-up actions when practical. A restart may resume or conservatively stop; it must not silently execute the same task revision twice merely because memory was lost.

## Checkpoint-and-proceed invariant

Human attention must not become a synchronous mutex for routine execution.

When a consequential decision surface is detected, PATCH-POLLER follows PP-007:

1. seal a durable checkpoint with enough evidence to reconstruct the decision;
2. identify the exact decision boundary or hard-gated effect;
3. continue reversible work that remains inside the current trusted envelope;
4. apply any accepted human decision only to the bound decision subject;
5. stop progressing only when the safe frontier is exhausted or a hard gate is the next required effect.

Silence is not approval. A model or human response cannot implicitly widen capability policy.

## Decision and publication integrity

Any approval used for an irreversible, externally visible, or promotion-like effect must be attributable and bound according to PP-007.

Payload-sensitive actions use exact artifact/commit binding. Architectural decisions may use a bounded decision-scope binding so ordinary descendant implementation work does not require repeated approval when the approved decision has not materially changed.

A material subject change invalidates prior approval rather than silently inheriting it.

## Single-worker assumption

Version 1 supports one active worker per queue. Local process locking is required before daemon mode is considered production-ready. Distributed task claiming is out of scope until GitHub-side coordination can provide a credible lease/ownership protocol.

Per-repository Git operations must eventually be serialized even if broader task concurrency is added later.

## Project identity

Remote input identifies projects by repository identity, never by a local path. Local policy owns the mapping. The canonical v1 form is `owner/name` with conservative GitHub-compatible segment validation.

## Dependency policy

Prefer Node standard-library capabilities. A dependency is justified only when it materially improves a boundary that would otherwise be fragile, especially authentication, sandboxing, platform integration, or durable state handling.
