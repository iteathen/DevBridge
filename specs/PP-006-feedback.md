# PP-006 — Feedback and Continuation Protocol

Status: active

## Goal

A coding run may need clarification or a decision from a chat-only coordinating agent. Feedback must be durable, attributable, context-linked, and inexpensive to poll.

## API discipline

PATCH-POLLER does not poll comment streams for every active task. Comment polling begins only when a run enters `blocked` / `awaiting-feedback` and stops when trusted feedback is accepted or the run terminates.

The comments endpoint uses the same authenticated conditional-request cache as task polling. Validators persist across restarts.

## Trust

Only comments authored by a locally allowlisted numeric GitHub user ID are eligible. Repository collaborators, issue participants, bots, and quoted text are not trusted merely because they can comment.

## Envelope

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

The `runId` and `taskRevision` must match the waiting run. Feedback for an old run/revision is ignored rather than applied to current work.

## Context merge

Accepted continuation feedback is appended to provenance and becomes durable input to the next context capsule. It may change the objective or constraints at the task level but cannot grant local capabilities.
