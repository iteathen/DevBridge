# ADR-0001: Use an outbound GitHub mailbox

- Status: accepted
- Date: 2026-08-17
- Owners: PATCH-POLLER architecture

## Context

The controlling ChatGPT Classic pathway can write durable GitHub comments but cannot directly access the user's local filesystem or terminal. The local machine may be behind NAT and should not expose an inbound service. The earlier bridge proved that a local Node.js process can poll GitHub, execute bounded local work, and return results, but it lacked sufficient progress reporting, context continuity, and account-conscious API governance.

## Decision

Use authenticated outbound polling of configured GitHub issue or pull-request comment mailboxes. Dispatches and lifecycle reports use strict versioned markers and JSON envelopes. The local daemon remains authoritative for trust, tools, paths, credentials, and capabilities.

A single shared governor serializes all GitHub API traffic for one credential identity. Conditional requests, persisted validators, adaptive idle backoff, mutation coalescing, and terminal-report reserves are mandatory.

## Rejected alternatives

### Local webhook listener

Lower latency, but requires an inbound endpoint, tunnel, or public service and expands the local attack surface.

### GitHub Actions or agentic workflows

Mature execution infrastructure, but routes work through a different model/account pathway and does not provide the desired direct local-machine authority split.

### Natural-language command bot

Convenient but unsafe. It makes unstructured remote text executable authority and cannot provide strict replay, scope, or capability guarantees.

### Adopt a general autonomous agent daemon

Projects such as Ove and Looper validate the broad pattern, but they own planning/agent behavior more broadly and do not provide PATCH-POLLER's exact dispatch, capability, context, and local-effect boundaries.

## Consequences

- Idle latency is bounded by the adaptive poll interval.
- GitHub API stewardship becomes a first-class subsystem.
- Comment edits and updated timestamps must be handled durably.
- One lifecycle comment is edited rather than creating progress spam.
- Local state must survive restart and prevent replay.
- Webhooks may be added later as another mailbox adapter without changing domain/application ownership.
