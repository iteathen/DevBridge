# DB-006 — Feedback and Continuation Protocol

Status: active

## Goal

A coding run may need clarification, redirection, cancellation, or a consequential decision from a chat-only coordinating agent or trusted maintainer. Feedback must be durable, attributable, context-linked, inexpensive to poll, and must not automatically turn human attention into a stop-the-world condition.

Ordinary continuation/cancel feedback uses this spec. Human checkpoint decisions use DB-007 and `devbridge/decision-v1`.

## API discipline

DevBridge does not poll comment streams for every active task.

Comment polling is enabled only while a run has an outstanding feedback request or checkpoint decision that local policy permits GitHub to resolve. The same authenticated conditional-request cache used by task polling applies, and validators persist across restarts.

Authority verification may require a second GitHub edit-provenance read after the REST comment list is fetched. That read uses the same serialized/rate-budgeted GitHub client. If provenance cannot be verified because of a transient API failure or a REST/GraphQL content race, DevBridge fails closed, clears the relevant REST conditional validator, and does **not** advance the durable feedback cursor. The exact comment can therefore be fetched and reverified later rather than disappearing behind a cached `304 Not Modified` response.

A pending feedback/decision request is an attention overlay, not automatically a blocked lifecycle state. DevBridge may continue safe/reversible work under DB-007 while polling economically for a response.

When the safe frontier is exhausted, the run may enter `waiting-decision` or another explicit waiting condition. Polling cadence may then back off within the GitHub-budget policy rather than burning account-wide API credits merely because a human has not replied.

## Trust

Ordinary feedback authority is bound to the **exact current comment-body bytes**, not merely to the original comment author.

For the GitHub issue-comment adapter:

- the original comment author numeric GitHub actor ID must be locally trusted;
- the current GraphQL body must exactly match the REST body whose envelope is being consumed;
- every retained edit actor must resolve to a locally trusted numeric actor ID;
- edited comments must retain creation provenance and a trusted current editor matching the retained final edit;
- an untrusted original cannot be made authoritative by a later trusted edit;
- an untrusted intermediate or current editor invalidates the comment for machine authority;
- missing, inconsistent, paginated/truncated, or retention-saturated edit provenance fails closed;
- a deleted historical diff remains attributable only when GitHub still exposes the editor identity and edit time; missing attribution fails closed.

Repository collaborators, issue participants, bots, labels, reactions, and quoted text are not trusted merely because they appear on the issue. Login names are display data; numeric actor IDs remain the durable local trust key.

Checkpoint decisions have additional authority matching requirements under DB-007. A user trusted to give ordinary continuation instructions is not automatically trusted to approve every decision class. Any GitHub-backed `devbridge/decision-v1` ingestion must apply this same exact-comment provenance check before DB-007 decision-class/digest authority is evaluated.

## Ordinary feedback envelope

Feedback uses exactly one fenced JSON block:

````markdown
```devbridge-feedback
{
  "protocol": "devbridge/feedback-v1",
  "runId": "run-identity",
  "taskRevision": "64-hex-task-revision",
  "action": "continue",
  "instructions": "Use option B and continue."
}
```
````

`action` is `continue` or `cancel`. A continuation must include non-empty instructions. Cancellation may include an explanatory note.

The `runId` and `taskRevision` must match the run. Feedback for an old run/revision is ignored rather than applied to current work.

DevBridge computes a SHA-256 digest over the complete exact comment body. Accepted feedback carries that digest plus sanitized edit-provenance evidence. Quoted examples are ordinary discussion: a Markdown blockquote containing a `devbridge-feedback` fence does not become machine authority.

Ordinary `continue` feedback does not authorize a DB-007 hard gate, approve an architectural decision boundary, or grant local machine capability.

## Context merge

Accepted continuation feedback is appended to provenance and becomes durable input to the next context capsule. The durable provenance record includes the exact comment digest and bounded editor/history metadata, not the complete comment body or edit diffs.

Authority-shaped feedback that is rejected because creator/editor provenance is untrusted or unverifiable is recorded in sanitized status/provenance output so an operator can distinguish “no response” from “response rejected by policy.”

Accepted continuation may change the objective or task-level constraints but cannot grant local capabilities or silently supersede an exact checkpoint decision requirement.

If ordinary feedback materially changes the subject of an existing checkpoint, DevBridge marks that checkpoint superseded or creates a new checkpoint as required by DB-007 instead of stretching prior approval.

## Bounded continuation windows

The local `maxTurns` setting is an automatic turn-window bound, not an absolute lifetime counter that makes trusted continuation ineffective.

When a run exhausts its current turn window, DevBridge may enter `waiting-feedback`. If a matching trusted `continue` is accepted at that frontier:

- the absolute run turn number remains monotonic and is never reset;
- DevBridge grants one additional local-policy-sized turn window;
- existing run/worktree/baseline identity is preserved;
- prior transient-retry state may be cleared so the new trusted window starts with fresh bounded retry accounting;
- no result/run directory is reused merely to make the counter fit;
- no capability, credential, network, Git, or decision authority is expanded.

This keeps autonomous work bounded while ensuring the continuation mechanism can actually continue a run after the automatic frontier is reached.

## Non-blocking clarification

A proposal engine may ask a question while still having useful work available. DevBridge should record and publish the question, then continue safe work that does not depend on the answer.

The run becomes truly waiting only when:

- all useful safe alternatives within the current objective/capability envelope are exhausted; or
- the next necessary action is bound to an unresolved decision/hard gate.

Implementations should avoid repeatedly asking the same question after model/context resets. Outstanding questions and attempted alternatives belong in the durable context capsule under DB-005.

## Cancellation

Trusted cancellation is a control-plane instruction, not a model suggestion. Once accepted, DevBridge stops launching new proposal/tool work for the run, terminates managed active work according to platform policy, records final evidence, and transitions to `cancelled` without crossing any pending hard gate.
