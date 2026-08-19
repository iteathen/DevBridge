# DB-005 — Context Capsules and Handoffs

Status: active

## Goal

No run may depend on a model remembering prior turns. Every coding-tool invocation can be treated as a fresh context window.

Human checkpoints and decisions are also durable run state. A context reset must not erase what was checkpointed, what remains pending, what was approved/rejected, or which decision subject the approval covered.

## Context capsule v1

A capsule is structured data with protocol `devbridge/context-v1` and includes, when available:

- task identity and immutable revision digest;
- objective/instructions;
- trusted constraints;
- provenance for remote/local inputs;
- prior decisions and rationale summaries;
- completed progress;
- changed files;
- tests/builds and their outcomes;
- branch and HEAD identity;
- blockers/unresolved questions;
- next step;
- bounded recent tool-output tail;
- sequence number and timestamps;
- active checkpoint IDs and concise decision surfaces;
- pending hard-gated effects;
- accepted/rejected/redirected decision provenance;
- the safe work frontier while a decision is pending;
- alternatives already attempted so a fresh model does not repeat failed work merely because its context reset.

Local capability grants and credentials are not copied into the model-visible capsule. The capsule may describe effective constraints (for example, `outside-project writes denied`) without exposing secrets.

## Coordinating-agent handoff relay

A trusted task may carry an optional bounded `context.handoff` string for durable coordinating-agent context. This field exists for context-window rehydration and handoff bundles; it is not an instruction or capability channel.

DevBridge, not the coding model, owns preservation of this payload:

- the exact UTF-8 handoff text is revision-bound task data;
- every context capsule carries the same handoff text while the run is active;
- the capsule also carries `handoffSha256`, computed by DevBridge over the exact UTF-8 bytes;
- GitHub status/handoff projection includes the handoff subject to the ordinary redaction boundary;
- coding tools may read and acknowledge the handoff, but correct relay must not depend on a model manually transcribing or reformatting it;
- runtime compaction preferentially removes expendable transcript/progress material rather than silently rewriting a bounded handoff payload.

The v0.1 handoff field is deliberately bounded to fit the existing single-comment context projection. Larger reconstruction bundles belong to the rehydration/chunking path below rather than to an unbounded issue field.

## Coordinating-chat rollover specialization

DB-014 (`specs/DB-014-context-rollover.md`) specializes this context contract for replacing the **coordinating chat/model session itself** rather than only replacing a subordinate coding-tool turn.

That specialization adds a separate bounded `devbridge/chat-handoff-v1` checkpoint containing exact Git/task identities, stable completed action IDs, one exact next action, governing-document digests, and durable evidence references. It is stored and verified by DevBridge before being advertised as resumable.

DB-014 does not replace `devbridge/context-v1`, does not make `context.handoff` unbounded, and does not create a second effect journal. The run/task context capsule remains the model-visible execution context; the chat handoff is a small controller-reconstruction index over durable run/Git/evidence state.

If a governing document changed between coordinating sessions, a fresh controller must reread that document before the chat handoff can release its recorded next action. If the action is already observed complete, the fresh controller checkpoints again rather than inventing a later action.

## Turn protocol

A multi-turn runner supplies the complete current capsule through stdin and/or an exact **control-owned** context endpoint for every invocation. A tool adapter may parse a structured result from the coding tool, but failure to emit a perfect result must not erase existing context.

Proposal-worker file IPC is not stored under the proposal worktree. For each exact `runId`/turn identity DevBridge creates a private mailbox below the configured control-state directory. The control plane owns:

- a manifest binding protocol, run ID, turn ID, filesystem identities, fixed worker-visible endpoints, and the SHA-256 of the exact context bytes;
- a pre-created context file;
- a pre-created bounded result file.

The worker does **not** receive the mailbox root or manifest. A verified OS isolation provider projects only the exact context file read-only and exact result file writable in place. The worker-visible paths are stable sandbox endpoints rather than host/project paths. Result writers must overwrite the existing file; replacing its inode by rename, symlink, junction, or another filesystem object is invalid.

Before a result is consumed as proposal data, DevBridge revalidates the control-owned turn directory, context/result identities, unchanged context digest, file type/ownership constraints, and result-size bound. No result path in the candidate tree is trusted during this operation.

An interrupted turn can be reopened by its exact run/turn identity from the control-owned manifest. Reopening revalidates the same invariants before returning any result. This makes abrupt-worker recovery independent of project-authored `.devbridge` files. A recovered result is still merely proposal data; candidate validation and control-plane effects remain authoritative.

The next capsule merges explicit durable state with new bounded observations. Critical constraints, active checkpoints, accepted decisions, decision boundaries, unfinished work, and the coordinating-agent handoff are retained before expendable transcript tail.

A new model turn must be told when it is operating while a checkpoint/decision is pending and exactly which effects remain prohibited. It must not infer approval from prior experimental work.

## Checkpoint context

DB-007 checkpoint records are richer than ordinary model context. The capsule carries only the bounded subset needed for correct continuation, including:

- checkpoint ID;
- checkpoint/decision type;
- decision-surface or artifact digest;
- concise rationale and architectural bounds;
- evidence/alternatives already gathered;
- current decision state;
- safe work that may continue;
- gated action that must not occur yet.

The full local checkpoint record remains reconstructable from `StateStore` even when only a summary is sent to a model or GitHub.

Accepted decisions are appended to provenance. For `artifact-exact` approvals, the exact approved digest is retained. For `decision-scope` approvals, the approved decision-surface digest and declared bounds are retained so future turns can detect when the scope materially changes and requires a new checkpoint.

## Remote updates

Progress reports include a condensed context capsule so a chat-only coordinating agent can understand current state without relying on conversation memory.

A checkpoint report should include enough context for a human or chat-only agent to make the decision without reconstructing the entire run transcript. It must state whether DevBridge is continuing safe work or has exhausted the safe frontier.

Terminal handoffs include the fuller capsule. If it exceeds a single safe comment budget, it is deterministically chunked with:

- run ID;
- chunk index/count;
- whole-payload SHA-256;
- task revision digest.

Chunking is used only when necessary because each additional comment is an API mutation.

## Rehydration tiers

Context rehydration should be progressive rather than defaulting to a complete repository upload.

- Tier 1: objective, constraints, current state, Git identities, checkpoints/decisions, and next safe step.
- Tier 2: Tier 1 plus current diff summary, relevant diagnostics, selected source excerpts, and derived architecture/build manifest data.
- Tier 3: a reconstruction bundle containing the baseline identity, candidate patch/commit, context/checkpoint records, relevant test evidence, selected bounded logs, and provenance needed to reproduce the run.

A full repository snapshot is exceptional and requires explicit local policy/operator intent. Private repositories must not be silently copied to a second remote service merely for convenience.

## Redaction

All capsule/checkpoint material is redacted before remote publication. A local, richer run record may exist, but it is still bounded and must not intentionally record credentials.
