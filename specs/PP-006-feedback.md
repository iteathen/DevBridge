# PP-006 — Feedback and Continuation Protocol

Status: active

## Goal

A coding run may need clarification, redirection, cancellation, or a consequential decision from a chat-only coordinating agent or trusted maintainer. Feedback must be durable, attributable, context-linked, inexpensive to poll, and must not automatically turn human attention into a stop-the-world condition.

Ordinary continuation/cancel feedback uses this spec. Human checkpoint decisions use PP-007 and `patch-poller/decision-v1`.

## API discipline

PATCH-POLLER does not poll comment streams for every active task.

Comment polling is enabled only while a run has an outstanding feedback request or checkpoint decision that local policy permits GitHub to resolve. The same authenticated conditional-request cache used by task polling applies, and validators persist across restarts.

A pending feedback/decision request is an attention overlay, not automatically a blocked lifecycle state. PATCH-POLLER may continue safe/reversible work under PP-007 while polling economically for a response.

When the safe frontier is exhausted, the run may enter `waiting-decision` or another explicit waiting condition. Polling cadence may then back off within the GitHub-budget policy rather than burning account-wide API credits merely because a human has not replied.

## Trust

Only comments authored by a locally allowlisted numeric GitHub user ID are eligible for ordinary feedback. Repository collaborators, issue participants, bots, labels, reactions, and quoted text are not trusted merely because they appear on the issue.

Checkpoint decisions have additional authority matching requirements under PP-007. A user trusted to give ordinary continuation instructions is not automatically trusted to approve every decision class.

## Ordinary feedback envelope

Feedback uses exactly one fenced JSON block:

````markdown
```patch-poller-feedback
{
  "protocol": "patch-poller/feedback-v1",
  "runId": "run-identity",
  "taskRevision": "64-hex-task-revision",
  "action": "continue",
  "instructions": "Use option B and continue."
}
```
````

`action` is `continue` or `cancel`. A continuation must include non-empty instructions. Cancellation may include an explanatory note.

The `runId` and `taskRevision` must match the run. Feedback for an old run/revision is ignored rather than applied to current work.

Ordinary `continue` feedback does not authorize a PP-007 hard gate, approve an architectural decision boundary, or grant local machine capability.

## Context merge

Accepted continuation feedback is appended to provenance and becomes durable input to the next context capsule. It may change the objective or task-level constraints but cannot grant local capabilities or silently supersede an exact checkpoint decision requirement.

If ordinary feedback materially changes the subject of an existing checkpoint, PATCH-POLLER marks that checkpoint superseded or creates a new checkpoint as required by PP-007 instead of stretching prior approval.

## Bounded continuation windows

The local `maxTurns` setting is an automatic turn-window bound, not an absolute lifetime counter that makes trusted continuation ineffective.

When a run exhausts its current turn window, PATCH-POLLER may enter `waiting-feedback`. If a matching trusted `continue` is accepted at that frontier:

- the absolute run turn number remains monotonic and is never reset;
- PATCH-POLLER grants one additional local-policy-sized turn window;
- existing run/worktree/baseline identity is preserved;
- prior transient-retry state may be cleared so the new trusted window starts with fresh bounded retry accounting;
- no result/run directory is reused merely to make the counter fit;
- no capability, credential, network, Git, or decision authority is expanded.

This keeps autonomous work bounded while ensuring the continuation mechanism can actually continue a run after the automatic frontier is reached.

## Non-blocking clarification

A proposal engine may ask a question while still having useful work available. PATCH-POLLER should record and publish the question, then continue safe work that does not depend on the answer.

The run becomes truly waiting only when:

- all useful safe alternatives within the current objective/capability envelope are exhausted; or
- the next necessary action is bound to an unresolved decision/hard gate.

Implementations should avoid repeatedly asking the same question after model/context resets. Outstanding questions and attempted alternatives belong in the durable context capsule under PP-005.

## Cancellation

Trusted cancellation is a control-plane instruction, not a model suggestion. Once accepted, PATCH-POLLER stops launching new proposal/tool work for the run, terminates managed active work according to platform policy, records final evidence, and transitions to `cancelled` without crossing any pending hard gate.
