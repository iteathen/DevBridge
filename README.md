# PATCH-POLLER

PATCH-POLLER is a local Node.js bridge between chat-only coding agents and a real development environment. It watches a narrowly configured GitHub issue queue, accepts structured tasks only from locally trusted GitHub identities, carries durable context between model turns, and invokes locally configured coding CLIs under explicit capability policy.

**Status:** foundation / pre-alpha. The safety, protocol, GitHub-budget, context, feedback, status, and generic process-runner primitives are implemented and tested. Managed Git provisioning and the full multi-turn task coordinator are the next implementation slice. Human checkpoint/decision behavior is specified but not yet implemented in the coordinator.

## Why it exists

A chat-only agent can coordinate work through GitHub but cannot compile, run tests, inspect a local toolchain, or use browser automation in the developer's environment. PATCH-POLLER supplies that local execution bridge without making remote text equivalent to shell access.

The core assumptions are:

- model conversation memory is not durable enough to be run state;
- GitHub API capacity may be shared with other tools on the account;
- repository content and task text can be hostile or simply wrong;
- `cwd` is not a sandbox;
- local CLI ecosystems differ, so coding tools must be adapters rather than hard-coded product logic;
- human judgment is valuable at consequential boundaries but should not become a synchronous mutex for routine execution.

## Foundation features

- Node.js ESM runtime with no third-party runtime dependencies.
- Strict `patch-poller/task-v1` issue-envelope parser.
- Numeric GitHub actor-ID trust allowlist.
- Remote tasks cannot specify commands, executables, local paths, raw environment, or credentials.
- GitHub REST adapter pinned to API `2026-03-10`.
- Authenticated conditional polling with persistent ETag/Last-Modified validators.
- Serialized API requests, shared-budget reserve floors, `X-Poll-Interval` observation, and secondary-limit retry metadata.
- Coalesced single-comment status reporter with bounded context capsule and redaction.
- `patch-poller/feedback-v1` continuation/cancel protocol.
- Checkpoint-and-proceed HITL contract with separate decision boundaries/hard gates specified in PP-007.
- Managed-workspace path policy with owner allowlists and symlink/junction escape checks.
- Generic local CLI profiles with static safe placeholders, environment allowlists, timeout/output bounds, and no shell interpolation.
- Coding-tool input through stdin/context files rather than argv interpolation.
- Structured context capsules designed to make every model turn independently restartable.
- Atomic local JSON state store.
- `doctor` and `poll-once` CLI entry points.

## Safety default for files outside the project

PATCH-POLLER does **not** default to allowing arbitrary read-only access to the rest of the machine. Read-only access can still expose SSH keys, cloud credentials, browser profiles, tokens, and private documents that a hostile task could exfiltrate.

The intended default is project read/write plus explicit read-only roots for required toolchains, SDKs, package caches, or reference data. Strong child-process filesystem/network enforcement belongs to a verified tool or OS sandbox adapter; PATCH-POLLER does not pretend that changing the working directory provides containment.

## GitHub API responsibility

The poller uses one stable, narrowly filtered Issues request and persists conditional validators across restarts. Routine polling protects a configurable fraction of the observed API budget, while a smaller emergency reserve is kept for terminal reporting/recovery. Requests are serialized and mutation pacing defaults above GitHub's one-second recommendation.

GitHub recommends webhooks instead of polling when deployment permits them. PATCH-POLLER keeps the `TaskSource` boundary replaceable so a webhook adapter can be added later without changing task execution.

## Human checkpoints

PATCH-POLLER's human-in-the-loop model is **checkpoint and proceed**, not stop and wait.

When a consequential architectural or operational decision deserves human judgment, the future coordinator will seal a durable evidence checkpoint and continue reversible work inside the current safe envelope. It waits only when that safe frontier is exhausted or the next required effect is hard-gated.

Broad refactor proposals should trigger a checkpoint plus a bounded search for architecture-preserving alternatives. Approval never comes from silence, and payload-sensitive approvals bind to an exact artifact/commit digest.

See `specs/PP-007-human-checkpoints.md` for the normative contract.

## Task example

````markdown
```patch-poller-task
{
  "protocol": "patch-poller/task-v1",
  "target": { "repository": "iteathen/example" },
  "instructions": "Implement the requested change, follow project specs, build, and test.",
  "requestedCapabilities": ["project.write", "process.execute"],
  "preferredTool": "codex",
  "context": {
    "summary": "Prior handoff can be carried here.",
    "constraints": ["Do not change the public API"]
  }
}
```
````

Requested capabilities are descriptive only. Local policy is authoritative.

## Setup

Requires Node.js 22.16.0 or newer.

1. Copy `config/patch-poller.example.json` to a local configuration file outside watched project repositories.
2. Set `github.queueRepository`, `trustedActorIds`, workspace owner rules, and a dedicated token environment-variable name.
3. Keep execution disabled until local tool profiles and their real sandbox behavior have been reviewed.
4. Set the configured token environment variable.
5. Run:

```text
node src/cli.js doctor --config <local-config.json>
node src/cli.js poll-once --config <local-config.json>
```

Do not commit the real local configuration if it contains machine-specific policy or secret-adjacent values.

## Engineering documents

- `AGENTS.md` — coding-agent operating rules.
- `docs/design-principles.md` — LEGO / SOLID / CUPID / KISS application.
- `docs/architecture.md` — control plane, ports, trust hierarchy, workspace and CLI model.
- `specs/PP-001-system.md` — system contract, authority, and lifecycle.
- `specs/PP-002-task-protocol.md` — task transport and revision identity.
- `specs/PP-003-security.md` — filesystem, process, network, secret, capability, and recovery policy.
- `specs/PP-004-github-budget.md` — API-limit behavior.
- `specs/PP-005-context-handoff.md` — durable model context, decisions, and handoffs.
- `specs/PP-006-feedback.md` — trusted continuation/cancel feedback.
- `specs/PP-007-human-checkpoints.md` — checkpoint-and-proceed HITL, decision boundaries, and hard gates.
- `docs/roadmap.md` — implementation slices and completion gates.

## Tests

```text
npm test
```

The current foundation suite covers task authority boundaries, path traversal/symlink escape, ETag persistence, serialized requests, rate reserves, redaction, CLI profile restrictions, environment scrubbing, feedback trust, and context compaction. PP-007 adds required future coordinator tests for non-blocking checkpoints, exact decision binding, stale-decision rejection, restart durability, and attention deduplication.

## License

AGPL-3.0-only. See `LICENSE`.
