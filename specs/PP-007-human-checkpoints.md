# PP-007 — Human Checkpoints and Decision Gates

Status: active

Implementation status: v0.1 enforces `artifact-exact` hard gates before sensitive candidate sealing **and task-branch publication**, with restart-safe decision state and exact GitHub decision provenance. Canonical `decision-scope` checkpoint/digest/invalidation primitives are implemented for scope-bound decision surfaces; automatic sensitive-change gating currently uses the stricter artifact-exact binding.

## Goal

Use human judgment where it has high leverage without turning the human into a synchronous mutex for routine coding work. PATCH-POLLER must prevent expensive architectural drift and unsafe irreversible actions while continuing useful reversible work whenever possible.

## Governing doctrine

**Checkpoint and proceed is the default. Stop and wait is exceptional.**

Human attention is a scarce control-plane resource. A request for human judgment must not automatically suspend the run. When PATCH-POLLER reaches a consequential decision surface it records a durable checkpoint, publishes a concise decision summary, and continues work that remains inside the current trusted capability and architectural envelope.

A run stops progressing only when either:

- the safe/reversible work frontier is exhausted; or
- the next action is a hard-gated effect that local policy forbids without an explicit trusted decision.

Silence never implies approval.

## Authority

PATCH-POLLER remains the single source of execution authority. Remote and local models are proposal engines.

A human decision can authorize only a decision class that local operator policy already permits that actor to decide. A GitHub comment cannot grant arbitrary filesystem, credential, executable, network, sandbox, or trust-policy capability.

The authority hierarchy in PP-003 remains in force even for trusted maintainers.

### v0.1 local decision delegation

Remote decision authority is disabled for a class unless local configuration explicitly lists numeric GitHub actor IDs under `execution.decisionAuthorities` for that class. The supported automatic hard-gate classes are:

- `security-capability`;
- `bootstrap-self-update`;
- `git-github-publication`;
- `workflow-release`;
- `public-contract`;
- `architectural-change`.

When one candidate triggers multiple classes, a remote actor must be locally authorized for **every** triggered class. PATCH-POLLER uses the intersection of those allowlists rather than the union, so a comment cannot combine partial delegations into broader authority. If the intersection is empty, the gate remains pending until local policy changes or the candidate changes; remote text cannot create an authorized actor.

The local approval TTL and architectural breadth thresholds are also operator configuration. They are not task fields and cannot be changed by a decision comment.

## Three control concepts

### Checkpoint

A checkpoint is an immutable evidence record saying that the current state or proposed direction deserves human visibility.

A checkpoint is normally non-blocking. It may be informational only, or it may expose a decision boundary. Creating a checkpoint does not authorize the proposed action and does not require PATCH-POLLER to stop safe work.

### Decision boundary

A decision boundary identifies a consequential choice that must not become authoritative without an accepted decision, while allowing exploration on either side of the boundary in disposable/local state.

Examples include a broad architectural refactor, public contract replacement, schema migration strategy, or dependency/framework substitution.

PATCH-POLLER may continue diagnostics, tests, benchmarks, impact analysis, architecture-preserving alternatives, and isolated experimental branches while a decision is pending.

### Hard gate

A hard gate forbids a specific effect until an authorized decision is accepted. Hard gates are intentionally rarer than checkpoints.

Local policy defines hard-gated effect classes. Recommended default hard gates include:

- merge/promotion into a protected or default branch;
- force-push or destructive remote history rewrite;
- release/tag/deployment or production migration effects;
- destructive operations outside unquestionably disposable PATCH-POLLER-owned state;
- publication using a credential or authority class not already granted to the run;
- changes to PATCH-POLLER's own trust/capability policy.

A locally configured staging/task-branch push may be checkpoint-only rather than hard-gated when it is intentionally reversible and separately permissioned. **However, once a candidate itself is classified as sensitive, v0.1 rechecks that candidate's artifact-exact hard gate before the task-branch push as well as before sealing.** This closes restart paths that could otherwise resume directly from an already sealed `publishing` state after an approval expired or was superseded.

Capability expansion beyond the active local sandbox/profile cannot be granted by remote approval alone; it requires the local policy mechanism defined in PP-003.

## Checkpoint record

Every checkpoint must be durable and restart-safe. It includes, when applicable:

- checkpoint ID and creation time;
- run ID and immutable task revision;
- repository identity and baseline SHA;
- current candidate/proposal SHA or content digest;
- checkpoint type and decision class;
- decision-surface digest or exact artifact digest, according to gate type;
- concise rationale;
- affected ownership boundaries/public contracts;
- diff/file/churn summary;
- tests/builds/benchmarks already executed and outcomes;
- alternatives attempted and why they failed or remain viable;
- known risks and rollback/recovery path;
- the exact action that is gated, if any;
- safe work PATCH-POLLER may continue while the checkpoint is pending;
- policy version and provenance needed to interpret the checkpoint.

The richer record remains local. Remote publication is bounded and redacted under PP-003 and PP-005.

## Continue-safe behavior

After creating a checkpoint, the coordinator computes a safe work frontier and proceeds within it. Useful work can include:

- reproduce or narrow the defect;
- run additional tests or diagnostics;
- inspect callers and downstream impact;
- benchmark candidate approaches;
- strengthen non-controversial characterization tests when local policy permits;
- attempt a bounded architecture-preserving fix;
- ask another configured proposal engine for an alternative;
- prepare an isolated experimental branch/worktree;
- produce a migration or rollback plan;
- improve the evidence presented with the checkpoint.

Work performed while a decision is pending must not silently cross that decision boundary or hard gate.

When no useful safe work remains, the run may enter `waiting-decision`. This is a legitimate resumable state, not a failure.

## Architectural-change checkpoint

PATCH-POLLER must support an architectural-change detector whose inputs are explicit, inspectable signals rather than a model's unsupported assertion that a refactor is necessary.

Signals may include:

- changes spanning established ownership/module boundaries;
- replacement/removal of a public API, port, contract, or schema;
- dependency/framework/platform substitution;
- database or persistent-data migration;
- broad file moves/deletions/renames;
- build/install/security-policy redesign;
- removal or weakening of existing tests or invariants;
- churn/file-count thresholds configured for the repository;
- an agent explicitly proposing a broad refactor as prerequisite to a narrower task.

No single size metric proves that a change is bad. The signals determine when human leverage is useful.

When this checkpoint fires, the default instruction to proposal engines is:

**Checkpoint the proposed refactor and continue searching, within configured effort bounds, for a solution that preserves the current architecture.**

If bounded architecture-preserving alternatives fail, the checkpoint is updated with that evidence. The human should see the failed alternatives and tradeoffs, not merely the agent's first refactor preference.

## Decision binding and invalidation

A trusted decision must bind to the exact decision subject that was reviewed.

Two binding modes are supported:

- `artifact-exact`: approval binds to an exact commit/content digest. Any artifact change invalidates the approval. Use for publication, destructive effects, releases, or other payload-sensitive gates.
- `decision-scope`: approval binds to a normalized decision-surface digest describing the architectural choice and its declared bounds. Descendant implementation work may proceed without reapproval while it remains inside those bounds.

For v0.1 automatic sensitive-candidate gates, PATCH-POLLER derives the artifact-exact subject from the immutable run baseline plus the sorted changed paths and their current file/deletion/symlink/executable identities. The subject is recomputed immediately before sealing and again before publication. A changed artifact supersedes the prior approval and requires a fresh checkpoint.

If the decision surface materially expands or changes, PATCH-POLLER creates a new checkpoint. It must never silently stretch an old approval to cover a new consequential choice.

Checkpoint decisions have explicit states such as `pending`, `approved`, `rejected`, `redirected`, `superseded`, or `expired`. Timeout/expiry does not become approval.

## Decision protocol

Checkpoint decisions use a protocol separate from ordinary continuation feedback:

````markdown
```patch-poller-decision
{
  "protocol": "patch-poller/decision-v1",
  "runId": "run-identity",
  "taskRevision": "64-hex-task-revision",
  "checkpointId": "checkpoint-identity",
  "subjectDigest": "64-hex-decision-or-artifact-digest",
  "action": "approve",
  "instructions": "Optional bounded guidance for this decision."
}
```
````

`action` is `approve`, `reject`, or `redirect`. `redirect` requires non-empty instructions.

The actor, run ID, task revision, checkpoint ID, subject digest, and locally configured decision authority must all match. Stale, quoted, malformed, or mismatched decisions are ignored rather than applied to current work.

When GitHub issue comments carry `patch-poller/decision-v1`, the **exact current comment-body bytes and edit provenance must be verified before any decision authority is evaluated**. The original comment author and every retained editor must satisfy the locally configured authority requirements for that decision class, the GraphQL body must match the REST bytes being consumed, and ambiguous/truncated/retention-saturated provenance fails closed under the same policy used by PP-006. A later trusted editor cannot launder an untrusted original or intermediate edit. The exact comment SHA-256 and sanitized edit provenance become part of the durable accepted/rejected decision evidence.

This provenance requirement is necessary but not sufficient: verified comment authorship/editorship does not bypass run/task/checkpoint/subject-digest matching or local decision-class delegation.

Accepted decisions become durable provenance and are injected into subsequent context capsules under PP-005.

## Status semantics

Recommended externally visible states distinguish attention from blockage:

- `CHECKPOINTED_CONTINUING`: human-visible checkpoint exists; safe work continues.
- `DECISION_PENDING_CONTINUING`: a decision boundary is pending; safe work continues outside it.
- `WAITING_DECISION`: the safe work frontier is exhausted.
- `HARD_GATE_PENDING`: a specific prohibited effect is ready but not authorized.

Implementations may map these to labels or presentation text, but labels are observability only and are not authority unless a separate spec explicitly defines a trusted label-authorship mechanism.

## Human-attention budget

PATCH-POLLER must avoid approval fatigue:

- deduplicate checkpoints with the same decision fingerprint;
- bundle closely related decision surfaces when doing so does not blur authority;
- do not repeatedly ping a human merely because polling cycles elapsed;
- escalate again only when the subject materially changes, a checkpoint expires, or new evidence changes the decision;
- continue resolving low-risk uncertainty autonomously within local policy;
- prefer one evidence-rich checkpoint over a stream of speculative questions.

The goal is to use human judgment for consequential choices, not routine execution.

## Restart and recovery

Pending checkpoints and decisions are persisted before dependent effects. After restart PATCH-POLLER reconstructs the same decision state, safe frontier, subject binding, and provenance. It must not duplicate a gated effect or forget that an approval was invalidated.

Experimental descendants may be retained or discarded according to worktree retention policy, but the checkpoint's baseline/candidate identities remain reconstructable.

## Required tests

Implementation of this spec requires tests proving at minimum:

- a checkpoint does not pause unrelated safe work;
- a decision boundary cannot be crossed while pending;
- a hard-gated effect cannot occur without matching trusted approval;
- stale or mismatched run/task/checkpoint/digest decisions are rejected;
- GitHub-backed decisions reject untrusted or unverifiable edit provenance before decision authority is evaluated;
- `artifact-exact` approval is invalidated by any payload change;
- `decision-scope` approval survives in-scope descendant edits but not a material scope change;
- silence/timeout never becomes approval;
- restart preserves pending/accepted decision state without duplicating effects;
- publication recovery cannot bypass an expired/superseded exact gate merely because the candidate was sealed before interruption;
- repeated equivalent checkpoints are coalesced rather than spamming the human.
