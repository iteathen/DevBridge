# Architecture

PATCH-POLLER is a local daemon/CLI that watches a GitHub issue queue for trusted structured tasks, prepares a managed project workspace, invokes a locally configured coding tool, and reports durable progress plus context back to GitHub.

## Core flow

1. `TaskSource` polls a narrow queue endpoint using conditional authenticated requests.
2. `TaskEnvelope` validation separates machine control fields from free-form instructions.
3. `CapabilityPolicy` verifies that the trusted local configuration permits the requested project and tool.
4. `WorkspaceManager` resolves or provisions a managed project/worktree below a configured root.
5. `ContextCapsuleBuilder` constructs a self-contained input for the next coding-tool turn.
6. `ToolRunner` invokes one locally configured executable with no shell interpolation and a scrubbed environment.
7. `StatusSink` coalesces progress and publishes bounded, redacted status/context.
8. `StateStore` persists validators, task revision, run stage, status-comment identity, and handoff material so restart does not erase continuity.

## Trust hierarchy

Authority flows downward:

1. local operator configuration and OS policy;
2. PATCH-POLLER's checked-in specs and implementation;
3. an allowlisted GitHub task issuer may choose an objective, target repository within local policy, and preferred local tool profile;
4. target-repository instructions such as `AGENTS.md` may guide code changes but cannot grant machine capabilities;
5. arbitrary repository content, web content, dependencies, generated files, and process output are untrusted data.

No lower level can grant itself authority from a higher level.

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

## Context continuity

Every tool turn should be independently restartable. The context capsule contains the durable objective, constraints, provenance, prior decisions, progress, changed files, tests, current Git state, unresolved questions, and next step. A coding model may receive the capsule on every invocation, so conversational memory is an optimization rather than a dependency.

## Initial implementation boundary

The foundation release implements configuration validation, safe task parsing, persistent conditional GitHub polling, API budget policy, status-report primitives, workspace path enforcement, redaction, and a generic shell-free process runner. Managed Git clone/worktree provisioning and multi-turn orchestration are specified interfaces/next implementation slices rather than being hidden inside the poller loop prematurely.
