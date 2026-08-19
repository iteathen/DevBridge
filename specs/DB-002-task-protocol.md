# DB-002 — GitHub Task Protocol

Status: active

Implementation status: current GitHub Issues task intake verifies exact current content plus trusted edit provenance. Task trust is local per-runner policy and is distinct from DB-016 coordination peer trust.

## Transport

The current task adapter uses GitHub Issues. A queue is configured by local `owner/repo` plus a task label such as `devbridge:ready`.

The poll endpoint should be as narrow and stable as possible. Pull requests returned by the Issues API are ignored.

An optional future TaskSource (for example a webhook adapter) must preserve the same authority/provenance semantics rather than creating a looser command channel.

## Trust

A task is eligible only when authority can be established for the **exact current issue-body bytes** DevBridge consumes.

Creator identity alone is not sufficient because GitHub allows mutable issue descriptions. For the GitHub Issues adapter:

- the original issue author numeric GitHub actor ID must be present in local `trustedActorIds`;
- login names are display data, not durable trust keys;
- DevBridge independently reads GitHub edit provenance for the same issue node and requires the current GraphQL body to equal the exact REST body being parsed;
- every retained edit actor must resolve to a trusted numeric actor ID;
- the current editor must be trusted and must match the retained edit corresponding to `lastEditedAt`;
- edited content must include creation provenance, so an untrusted original cannot be laundered by a later trusted edit;
- missing actor identity, missing creation provenance, truncated/paginated history, inconsistent metadata, or an edit history at GitHub's retention ceiling is ambiguous and fails closed;
- deletion/redaction of a historical diff does not by itself grant or remove authority: if GitHub still exposes editor identity/time, those are checked; if attribution is missing, authority fails closed.

A REST/GraphQL race is never accepted. DevBridge clears the persisted REST conditional validator so latest bytes can be fetched and reverified on a later bounded poll.

No task can grant machine privileges. A task may request capabilities or a preferred locally configured tool profile, but local policy decides whether those requests are allowed.

### `trustedActorIds` is job-submission authority

A numeric actor in a runner's local `github.trustedActorIds` is permitted to author trusted remote development tasks for that runner's configured queue. This is meaningful authority and must not be populated merely from a repository's collaborator/team membership.

When that runner has execution enabled, a trusted actor can cause development work, including locally permitted repository-code execution, to occur on that machine within the existing local capability/sandbox policy.

This does **not** mean the actor can send arbitrary host commands. The task protocol does not carry shell/argv/path/environment/credential authority, and DB-003 remains authoritative for all machine capabilities. It does mean the actor is a trusted remote work submitter.

### Current multi-runner routing boundary

DB-016 task leases coordinate ownership among already authorized installations. A lease or trusted peer public key is **not** task-author authority and is not a human-to-workstation routing ACL.

The current `devbridge/task-v1` envelope does not contain a cryptographically bound destination installation/agent identity. Consequently, if multiple runners observe the same queue and locally trust the same task actor, any eligible runner may claim that trusted task according to DB-016 coordination state.

A deployment requiring developer A to be unable to dispatch work to developer B's workstation MUST currently enforce that boundary through B's local queue and/or `trustedActorIds` policy. It MUST NOT claim that DB-016 identity/leases alone provide per-workstation dispatch isolation.

A future per-installation addressing/dispatch mechanism may narrow routing, but it MUST preserve this exact task provenance model and MUST NOT turn agent signatures into an alternate capability-grant or arbitrary-command channel.

## Envelope

The issue body must contain exactly one top-level fenced block:

````markdown
```devbridge-task
{
  "protocol": "devbridge/task-v1",
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

The task protocol deliberately has no `command`, `shell`, `cwd`, `localPath`, `executable`, raw environment, credential, sandbox exception, peer key, Git-force mode, or daemon-control fields.

Current v1 also has no destination-agent/installation field. Do not infer one from task text, issue labels, repository branch names, or a DB-016 lease owner.

Quoted examples are discussion, not authority. A Markdown blockquote containing a `devbridge-task` fence does not count as the top-level machine envelope.

## Target repository authority

`target.repository` is a logical GitHub `owner/name`, not a machine path.

Local workspace policy decides whether the owner/repository is allowed and maps it into DevBridge-owned managed storage. A task cannot select an arbitrary existing checkout, workspace root, baseline ref, clone transport, credential, or Git administration path.

## Revision identity

DevBridge computes an exact UTF-8 SHA-256 over the complete current issue body and incorporates that content digest into the normalized task-envelope revision digest. The GitHub issue identity plus that revision forms the task revision.

This deliberately means any change to authoritative issue-body bytes changes revision identity even if the parsed machine envelope itself is unchanged. Once a revision is claimed, later edits cannot silently mutate or inherit the running instruction set.

The accepted task record carries sanitized content-provenance evidence including exact body digest, creator actor ID, editor actor IDs, edit count, redacted-history count, history-completeness state, and last-edit time where applicable. Edit diffs and complete bodies are not published as provenance metadata.

Trusted continuation/decision comments use the same exact-content provenance principle under DB-006/DB-007; mutable comments cannot inherit authority from creator identity alone.

DB-016 leases bind the exact task revision digest. Lease ownership therefore cannot silently retarget a different issue-body revision.

## Bounds

The parser enforces bounded instruction and context sizes. Oversized input is rejected rather than truncated into a potentially different instruction.

Bounds are parser/safety policy; they are not capability grants and cannot be relaxed by task text.
