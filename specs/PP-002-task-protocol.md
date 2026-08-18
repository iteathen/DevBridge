# PP-002 — GitHub Task Protocol

Status: active

## Transport

The initial adapter uses GitHub Issues. A queue is configured by local `owner/repo` plus a task label such as `patch-poller:ready`.

The poll endpoint should be as narrow and stable as possible. Pull requests returned by the Issues API are ignored.

## Trust

A task is considered eligible only when the issue author numeric GitHub user ID is present in the local `trustedActorIds` set. Login names are display data, not the durable trust key.

No task can grant privileges. The task may request capabilities or a preferred tool profile, but local policy decides whether those requests are allowed.

## Envelope

The issue body must contain exactly one fenced block:

````markdown
```patch-poller-task
{
  "protocol": "patch-poller/task-v1",
  "target": { "repository": "owner/name" },
  "instructions": "Implement and test the requested change.",
  "requestedCapabilities": ["project.write", "process.execute"],
  "preferredTool": "codex",
  "context": {
    "summary": "Optional prior handoff",
    "constraints": ["Preserve public API"]
  }
}
```
````

Required fields are `protocol`, `target.repository`, and `instructions`.

The task protocol deliberately has no `command`, `shell`, `cwd`, `localPath`, `executable`, raw environment, or credential fields.

## Revision identity

PATCH-POLLER computes a SHA-256 digest over the parsed envelope. The GitHub issue identity plus that digest forms the task revision. Once a revision is claimed, later edits do not silently mutate the running instruction set.

A future feedback/continuation protocol may create a new revision from trusted comments. Normal runs should not poll issue comments unless feedback is actually needed.

## Bounds

The parser enforces bounded instruction and context sizes. Oversized input is rejected rather than truncated into a potentially different instruction.
