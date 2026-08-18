# PP-005 — Context Capsules and Handoffs

Status: active

## Goal

No run may depend on a model remembering prior turns. Every coding-tool invocation can be treated as a fresh context window.

Human checkpoints and decisions are also durable run state. A context reset must not erase what was checkpointed, what remains pending, what was approved/rejected, or which decision subject the approval covered.

## Context capsule v1

A capsule is structured data with protocol `patch-poller/context-v1` and includes, when available:

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

## Turn protocol

A multi-turn runner writes the complete current capsule to a poller-owned run file and/or stdin for every invocation. A tool adapter may parse a structured result from the coding tool, but failure to emit a perfect result must not erase existing context.

The next capsule merges explicit durable state with new bounded observations. Critical constraints, active checkpoints, accepted decisions, decision boundaries, and unfinished work are retained before expendable transcript tail.

A new model turn must be told when it is operating while a checkpoint/decision is pending and exactly which effects remain prohibited. It must not infer approval from prior experimental work.

## Checkpoint context

PP-007 checkpoint records are richer than ordinary model context. The capsule carries only the bounded subset needed for correct continuation, including:

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

A checkpoint report should include enough context for a human or chat-only agent to make the decision without reconstructing the entire run transcript. It must state whether PATCH-POLLER is continuing safe work or has exhausted the safe frontier.

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
