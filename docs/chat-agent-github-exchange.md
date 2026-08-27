# Chat-only agent GitHub exchange

## Status and purpose

This document defines the accepted target transport for chat-only coding agents that can reach DevBridge only through capabilities natively exposed by their chat product.

The primary design rule is:

> **Use GitHub Issues as the universal chat-agent mailbox, preserve the admitted task as an exact structured revision/digest, and keep large or immutable package members behind exact Git object references.**

This design builds on DevBridge's existing GitHub issue task source and provenance checks. It does not replace DB-002 task provenance, DB-003 local capability authority, DB-009 reconciliation, DB-016 lease/fence authority, or DB-020 VM-only repository execution.

The goal is broad chat-agent compatibility without requiring a locally hosted HTTP/WebSocket/MCP service, inbound workstation connectivity, or a custom client on the agent side.

## Why GitHub Issues are the primary exchange object

Chat-only coding agents are commonly given native GitHub access even when they cannot open arbitrary local sockets or invoke a custom workstation tool directly. Issues are a particularly useful common denominator because they provide:

- authenticated GitHub actor identity;
- durable repository-scoped objects;
- a natural queue/mailbox lifecycle;
- labels and open/closed state for human/operator projections;
- comments for bounded progress/results;
- timestamps and edit history/provenance inputs;
- stable issue/node identities;
- straightforward polling through GitHub APIs;
- no required inbound connection to the DevBridge host.

DevBridge already polls labeled issues, verifies trusted creators, parses structured task envelopes, and checks exact content provenance/digests before admission. The new exchange design should extend that seam rather than replace it with a separate transport stack.

## Roles of GitHub resources

Do not force one GitHub primitive to serve every role.

### Issue

The Issue is the **mailbox and task-package manifest**.

It carries:

- queue identity;
- submitter identity through GitHub provenance;
- bounded structured task/action envelope;
- references to larger package members when needed;
- human-readable title/summary where useful;
- labels/state as non-authoritative queue/status projections.

The Issue body is mutable in GitHub, so the current body is not automatically the admitted task after execution begins. DevBridge binds authority to the exact admitted issue identity + verified revision/content digest.

### Git blobs/files/commits

Git objects are the **immutable/reusable package-member layer** when an Issue body should not inline the payload.

Use exact object/commit identities for payloads such as:

- larger structured context;
- patches/diffs that should be immutable;
- reusable instruction artifacts;
- source/context snapshots when Git is the appropriate carrier;
- package manifests that exceed the preferred Issue-body size;
- other text payloads whose exact identity matters independently of the Issue body.

Prefer references pinned to exact blob/commit identity over mutable default-branch paths when immutability matters.

Do not require an extra Git commit/blob indirection for every small task. A bounded task manifest can remain directly in the Issue body.

### Issue comments

Comments are primarily **bounded status/result projections**, not the execution-state database.

A result comment may contain a structured envelope with:

- request/task identity;
- current state;
- DevBridge execution/result identity;
- exit/timeout/cancellation summary;
- bounded stdout/stderr previews;
- named buffer/cache/artifact handles;
- exact candidate/verification references where host policy permits projection;
- next permitted interaction or terminal state.

Large buffers, cache contents, SQL state, build trees, and bulk artifacts stay in DevBridge/guest storage unless explicitly transferred.

Comments must not become an unbounded transcript dump.

### Labels and Issue state

Labels and open/closed state are convenient **projections**, not machine authority.

Examples may include:

- `devbridge`;
- `devbridge:queued`;
- `devbridge:active`;
- `devbridge:blocked`;
- `devbridge:complete`.

An agent adding `devbridge:complete`, closing an Issue, or editing visible status text does not declare the DevBridge run complete. DevBridge's local durable state and validated external effects remain authoritative.

## Canonical exchange flow

Conceptually:

```text
chat-only agent
      |
      | native GitHub access
      v
GitHub Issue
  - bounded task manifest
  - exact creator/edit provenance
  - optional immutable Git refs
      |
      | outbound HTTPS polling
      v
trusted DevBridge host
  - provenance verification
  - exact revision/digest admission
  - local capability/routing policy
  - durable request identity
      |
      v
repository execution profile / VM
  - agent execution runtime
  - SQLite / buffers / caches / CAS
      |
      v
trusted host validation/reconciliation
      |
      v
bounded structured Issue comment/status projection
      |
      v
chat-only agent
```

No local web API is required. DevBridge initiates outbound GitHub requests under its existing rate-budget and authentication policy.

## Task package shape

The exact syntax remains versioned by the DevBridge task protocol, but the Issue body should behave as a bounded manifest rather than a long conversational prompt.

Conceptually it contains:

```json
{
  "protocol": "devbridge/task-vN",
  "requestId": "stable-request-id",
  "target": "optional-addressed-installation-or-policy-subject",
  "repository": "owner/repository",
  "intent": {
    "kind": "coding-task",
    "instructions": "bounded instructions"
  },
  "inputs": [
    {
      "name": "context",
      "ref": "exact-git-object-or-other-admitted-reference"
    }
  ],
  "limits": {}
}
```

This example is illustrative. Do not bypass the live task-envelope schema or create host authority fields merely because they appear useful in a transport example.

The package should remain:

- bounded;
- versioned;
- structurally parseable;
- explicit about referenced package members;
- free of host executable paths, credentials, provider-management targets, or arbitrary local filesystem authority;
- stable under content hashing/canonicalization rules defined by the protocol.

## Admission identity and mutable Issue bodies

GitHub Issues can be edited. DevBridge therefore must not treat `issue.number` or the current visible body alone as the execution subject.

Admission binds at least:

```text
queue repository
+ issue/node identity
+ verified creator/provenance
+ admitted task revision
+ admitted content digest
```

If the Issue is edited after admission, the edit is a **new candidate revision**, not an invisible mutation of the running task.

A new revision must be independently parsed, provenance-checked, authorized, and reconciled according to the task protocol. It cannot retroactively change an action that already ran.

If an identical admitted request is seen again, DevBridge should observe/reconcile its durable request/execution state before repeating anything. Reusing the same request identity with different content fails closed.

## Action granularity and follow-up interactions

Do not turn one Issue into an unstructured infinite remote shell transcript.

Keep these identities distinct:

- **task/mailbox Issue** — the GitHub object through which the chat agent submits work;
- **task/action revision** — the exact admitted structured request;
- **execution** — the local DevBridge/guest execution identity;
- **result projection** — the bounded GitHub status/comment representing observed state.

For the initial exchange design, Issue bodies remain the authoritative remote submission source and comments remain result/status projections. This matches the existing `IssueTaskSource` security/provenance seam.

If future work admits follow-up action packets from comments, comment provenance must reach the same standard as Issue-body provenance and every action must have an independent stable request ID/digest. Free-form conversational comments must never silently become command authority.

Where a chat-only agent needs another operation before comment-action admission exists, a new structured Issue/revision is safer than treating prose replies as executable intent.

## Interaction with the agent execution runtime

The GitHub exchange transports requests/results; it does not replace the guest execution runtime.

Examples of requests that may eventually be represented through admitted task/action envelopes include:

- execute a structured or POSIX-shaped guest operation;
- run a read-only SQL query over guest execution state;
- read/search a named buffer;
- inspect execution history;
- request a named cache when valid;
- retrieve a bounded artifact/result reference.

The GitHub package does not directly mutate the guest SQLite database. Runtime-owned process/storage methods remain the only writers to authoritative guest execution state.

The full large data remains local whenever possible. GitHub carries small structural requests and bounded structural responses.

## Results and large-data policy

Do not copy full long-running output into GitHub comments merely because comments are available.

A result projection should prefer:

```text
execution identity
state / exit summary
stdout buffer handle + bounded preview
stderr buffer handle + bounded preview
artifact/cache references
line/byte counts
digests where appropriate
```

The chat agent can submit another admitted request for the exact buffer range, search, SQL query, or artifact it needs.

This preserves model context, GitHub rate budget, repository readability, and DevBridge's structural state model.

Binary/very large guest data should remain reference-only unless an explicit transfer path is justified.

## Security and authority

GitHub authentication answers **who submitted or changed a GitHub object**. It does not answer **what that actor is allowed to cause on the workstation**.

DevBridge therefore preserves all existing local authority checks:

- `github.trustedActorIds` (or its future replacement) remains a local submission allowlist, not a generic collaborator list;
- repository/profile/workspace routing remains local policy;
- executable/capability authority remains local/guest-admitted policy;
- host paths, credentials, Git publication authority, leases, provider management, and verification authority remain unavailable to remote task packets;
- guest results remain untrusted until host validation where host authority/evidence is required.

Do not infer authorization from Issue labels, assignees, milestones, project boards, emoji/reactions, closure state, or prose such as "approved" unless a separate typed/provenance-controlled contract explicitly gives that object meaning.

## Delivery, polling, and rate budget

The default chat-agent exchange must work with outbound polling only.

Use the existing GitHub conditional-request/rate-budget discipline:

- conditional GET/validators where applicable;
- bounded oldest-first task scanning;
- persisted poll/rate state as currently required;
- backoff/server pacing;
- exact reconciliation after transient/provenance failures;
- no busy-loop polling merely to simulate a local socket.

Webhook/event delivery may be added as an optimization when available, but it must feed the same task-source/provenance contract. It must not create a second authority model.

## Structured state preservation

The exchange should preserve structure end to end:

```text
Issue task envelope
   -> parsed task object
   -> admitted exact revision/digest
   -> normalized DevBridge action
   -> guest execution IR / SQL query / buffer operation
   -> structured runtime result
   -> bounded structured GitHub result projection
```

Avoid serializing structured state into prose and then asking the next agent/runtime layer to reconstruct it.

Human-readable summaries may accompany the structured envelope, but they are projections rather than the canonical machine state.

## Why not other GitHub resources as the primary mailbox

### Pull requests

PRs imply source-review/merge semantics and couple task transport to Git history/publication workflow. Use them for code review/publication where appropriate, not as the universal task mailbox.

### GitHub Actions artifacts

Artifacts require an Actions run and have retention/download semantics suited to CI outputs rather than a general interactive task queue.

### Releases

Releases are heavyweight publication objects and have the wrong lifecycle.

### Discussions

Discussions are less universally exposed by coding-agent integrations and do not materially improve the queue/provenance model over Issues.

### Repository dispatch / workflow dispatch

Dispatch events can trigger automation but are poor durable readable task mailboxes. They may be optional wake-up signals, not the canonical package.

### Repository files alone

Files/commits are excellent immutable payload carriers but a weaker universal agent mailbox: creating branches/commits correctly adds friction, queue/status semantics are less natural, and chat integrations more consistently expose Issues. Use Git objects as payload members where their exact immutable identity is valuable.

## Compatibility with future MCP or richer connectors

MCP or other typed tool transports may later provide lower-latency direct methods for agents that support them.

They should be adapters over the same DevBridge task/action/result contracts rather than a replacement authority model.

The GitHub Issue exchange remains the broad chat-only compatibility path because it requires only the GitHub capabilities commonly available to coding-oriented chat agents and no inbound DevBridge server.

## Implementation direction

Evolve the existing GitHub modules rather than building a parallel queue stack.

Likely ownership remains:

- `IssueTaskSource` / task-envelope/provenance code — Issue admission, exact revision/digest, creator/edit provenance;
- GitHub client/rate budget — conditional polling and bounded API behavior;
- status/result reporter — structured bounded result/comment projection;
- content-provenance — edit/race/provenance validation;
- task/run coordinator — durable local admission/reconciliation;
- agent execution runtime — guest process/query/buffer/cache execution;
- host verification/publication modules — authoritative validation/effects.

Do not put guest execution semantics, SQL parsing, buffer storage, VM provider details, or host publication authority into the Issue adapter.

## Qualification requirements

At minimum, qualification should prove:

- untrusted Issue creators are rejected before execution;
- Issue edits are detected and bound to a new digest/revision rather than silently mutating an admitted task;
- provenance failure/races fail closed and do not disappear behind stale conditional validators;
- request-ID reuse with different content is rejected;
- repeated observation of the same admitted request does not duplicate a completed non-idempotent action without reconciliation;
- labels/Issue state cannot declare local completion/approval/authority;
- comments cannot become executable commands unless a future explicit typed/provenance contract enables them;
- large output is projected by bounded references rather than comment dumps;
- exact Git object references remain stable when used as immutable package members;
- missing/mutable payload references fail closed when exact identity is required;
- GitHub outage/rate limiting pauses remote exchange without weakening local execution authority;
- no inbound workstation web API is necessary for the default path;
- provider/guest compromise cannot use the exchange to obtain host credentials or publication/provider authority.

## Governing relationship

Read this document with:

- `specs/DB-002-task-protocol.md` for remote task identity/provenance;
- `specs/DB-003-security.md` for local capability authority;
- `specs/DB-004-github-budget.md` for API/rate behavior;
- `specs/DB-009-effects-recovery.md` for ambiguity/reconciliation;
- `specs/DB-010-provenance-control-channels.md` for provenance requirements;
- `specs/DB-013-controller-plans.md` for structured controller intent;
- `specs/DB-016-agent-identity-leases.md` for distributed ownership/fencing;
- `specs/DB-020-vm-execution-boundary.md` for repository execution security;
- `docs/agent-execution-runtime.md` for the guest execution/query/data runtime;
- `docs/architecture.md` for trust and authority topology.

Where this document describes an ergonomic transport choice, normative security/provenance contracts still win.
