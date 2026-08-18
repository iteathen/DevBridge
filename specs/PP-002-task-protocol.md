# PP-002 — GitHub Task Protocol

Status: active

## Transport

The initial adapter uses GitHub Issues. A queue is configured by local `owner/repo` plus a task label such as `patch-poller:ready`.

The poll endpoint should be as narrow and stable as possible. Pull requests returned by the Issues API are ignored.

## Trust

A task is eligible only when authority can be established for the **exact current issue-body bytes** PATCH-POLLER consumes.

Creator identity alone is not sufficient because GitHub allows mutable issue descriptions. For the GitHub Issues adapter:

- the original issue author numeric GitHub actor ID must be present in local `trustedActorIds`;
- login names are display data, not durable trust keys;
- PATCH-POLLER independently reads GitHub edit provenance for the same issue node and requires the current GraphQL body to equal the exact REST body being parsed;
- every retained edit actor must resolve to a trusted numeric actor ID;
- the current editor must be trusted and must match the retained edit corresponding to `lastEditedAt`;
- edited content must include creation provenance, so an untrusted original cannot be laundered by a later trusted edit;
- missing actor identity, missing creation provenance, truncated/paginated history, inconsistent metadata, or an edit history at GitHub's retention ceiling is ambiguous and fails closed;
- deletion of a historical diff does not by itself grant or remove authority: if GitHub still exposes the editor identity and edit time, those are checked; if that attribution is missing, authority fails closed.

A REST/GraphQL race is never accepted. PATCH-POLLER clears the persisted REST conditional validator so the latest bytes can be fetched and reverified on a later bounded poll.

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

Quoted examples are discussion, not authority. A Markdown blockquote containing a `patch-poller-task` fence does not count as the top-level machine envelope.

## Revision identity

PATCH-POLLER computes an exact UTF-8 SHA-256 over the complete current issue body and incorporates that content digest into the normalized task-envelope revision digest. The GitHub issue identity plus that revision forms the task revision.

This deliberately means that any change to the authoritative issue-body bytes changes revision identity even if the parsed machine envelope itself is unchanged. Once a revision is claimed, later edits cannot silently mutate or inherit the running instruction set.

The accepted task record also carries sanitized content-provenance evidence including the exact body digest, creator actor ID, editor actor IDs, edit count, redacted-history count, history-completeness state, and last-edit time where applicable. Edit diffs and complete bodies are not published as provenance metadata.

Trusted continuation/decision comments use the same exact-content provenance rule under PP-006/PP-007; mutable comments cannot inherit authority from creator identity alone.

## Bounds

The parser enforces bounded instruction and context sizes. Oversized input is rejected rather than truncated into a potentially different instruction.
