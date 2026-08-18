# Architecture

PATCH-POLLER is a local daemon/CLI that watches a GitHub issue queue for trusted structured tasks, prepares a managed project workspace, invokes locally configured coding tools as subordinate proposal engines, validates their results, and reports durable progress plus context back to GitHub.

## Control-plane model

PATCH-POLLER owns authoritative run state, Git workspace state, capability policy, decision state, and publication state. Remote and local LLMs do not own the control plane; they propose work to it.

The core orchestration path is intentionally explicit rather than being an emergent chain of event listeners:

`TaskSource -> TrustGate -> RunCoordinator -> WorkspaceManager -> ProposalRunner -> Validator -> EvidenceCollector -> Status/CheckpointSink -> DecisionGate -> Publisher`

Events may describe state changes and feed observability, but a durable `RunCoordinator` decides lifecycle transitions. This avoids hidden execution authority emerging from loosely coupled callbacks.

## Core flow

1. `TaskSource` polls a narrow queue endpoint using conditional authenticated requests.
2. `TaskEnvelope` validation separates machine control fields from free-form instructions.
3. `CapabilityPolicy` verifies that trusted local configuration permits the requested project and tool.
4. `RunCoordinator` creates or resumes a durable run and is the only component allowed to advance authoritative lifecycle state.
5. `WorkspaceManager` resolves or provisions a managed project/worktree below a configured root.
6. `ContextCapsuleBuilder` constructs a self-contained input for the next coding-tool turn.
7. `ToolRunner` invokes one locally configured executable with no shell interpolation and a scrubbed environment.
8. proposal/result validation checks whether the model output may become candidate workspace state.
9. checkpoint policy identifies consequential decision surfaces without automatically stopping safe work.
10. `StatusSink` coalesces progress/checkpoints and publishes bounded, redacted status/context.
11. trusted feedback/decisions are matched to the exact run/task/checkpoint subject before they can affect state.
12. `StateStore` persists validators, task revision, run stage, checkpoints, decisions, status-comment identity, and handoff material so restart does not erase continuity.

## Trust hierarchy

Authority flows downward:

1. local operator configuration and OS policy;
2. PATCH-POLLER's checked-in specs and implementation;
3. locally configured human decision delegation for specific decision classes;
4. an allowlisted GitHub task issuer may choose an objective, target repository within local policy, and preferred local tool profile;
5. target-repository instructions such as `AGENTS.md` may guide code changes but cannot grant machine capabilities;
6. remote/local LLM output, arbitrary repository content, web content, dependencies, generated files, and process output are proposal/data inputs.

No lower level can grant itself authority from a higher level.

A human decision received remotely is not a general override. It is accepted only when local policy delegates that decision class to the actor and the decision matches the current run/task/checkpoint subject.

## Checkpoint-and-proceed control

Human attention is modeled separately from the primary run lifecycle.

A run may be actively `running` or `verifying` while an architectural checkpoint or decision is pending. The coordinator computes a safe work frontier and continues reversible work that does not cross the pending decision boundary.

Only when that safe frontier is exhausted does the run become genuinely `waiting-decision`. Hard-gated effects remain prohibited regardless of how much experimental work has continued.

PP-007 defines checkpoint evidence, architectural change detection, decision binding, approval invalidation, and human-attention budgeting.

## Managed workspace model

The long-term workspace layout is intentionally poller-owned rather than a user's casual checkout:

```text
<workspace-root>/
  repositories/<owner>/<repo>/
  worktrees/<owner>/<repo>/<run-id>/
  runs/<run-id>/
```

A task names a repository (`owner/name`), never a local path. Local policy maps that identity into the workspace root. New directories may be created only under that root and only for allowed owners/repositories.

Dedicated worktrees are preferred for task execution because they isolate work, make recovery easier, and avoid destructive cleanup of a user's existing checkout.

Failed, waiting, or checkpointed worktrees may need retention until evidence is sealed or the run can be resumed. Cleanup is therefore lease/ownership based rather than an unconditional `finally()` deletion rule.

## CLI flexibility

Tool profiles are local configuration. A profile owns:

- executable identity;
- static argv template with a small set of safe placeholders;
- environment-variable allowlist;
- timeout and output bounds;
- input/result transport;
- a declared sandbox contract.

Remote task text is sent through stdin or a context file. It is never interpolated into argv, executable names, environment names/values, or local paths.

A profile's sandbox contract is an operator assertion about a real enforcement mechanism supplied by the CLI or OS. PATCH-POLLER must not pretend that `cwd` alone confines a process.

Local repair/first-aid agents use the same proposal/validation architecture. Being local does not give them privileged bypass around file, test, sandbox, publication, or checkpoint policy.

## Context continuity

Every tool turn should be independently restartable. The context capsule contains the durable objective, constraints, provenance, prior decisions, progress, changed files, tests, current Git state, active checkpoints, pending gates, unresolved questions, safe work frontier, attempted alternatives, and next step.

A coding model may receive the capsule on every invocation, so conversational memory is an optimization rather than a dependency. A context reset cannot erase a checkpoint or silently convert a pending decision into approval.

## Initial implementation boundary

The foundation release implements configuration validation, safe task parsing, persistent conditional GitHub polling, API budget policy, status-report primitives, workspace path enforcement, redaction, and a generic shell-free process runner.

Managed Git clone/worktree provisioning, the durable `RunCoordinator`, checkpoint/decision orchestration, platform sandbox adapters, and full multi-turn execution are explicit next implementation slices rather than being hidden inside the poller loop prematurely.
