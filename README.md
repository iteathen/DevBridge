# PATCH-POLLER

PATCH-POLLER is a local Node.js bridge between chat-only coding agents and a real development environment. It watches a narrowly configured GitHub issue queue, accepts structured tasks only from locally trusted GitHub identities, carries durable context between model turns, and invokes locally configured coding CLIs under explicit capability policy.

**Status:** v0.1 first usable implementation / pre-production hardening. The end-to-end local execution path is implemented and tested. Full PP-007 decision orchestration, universal OS sandbox adapters, package-manager phase isolation, GitHub App authentication, and the complete remote-effect journal remain explicit hardening work rather than hidden assumptions.

## What v0.1 does

- Polls a trusted GitHub Issues queue with persistent conditional requests and shared-account rate reserves.
- Rejects tasks from untrusted numeric GitHub actor IDs or malformed task envelopes.
- Maps `owner/name` targets into PATCH-POLLER-owned repositories/worktrees; a task never supplies a local path.
- Uses a controlled Git environment with hooks, inherited credential helpers, interactive prompts, and dangerous transports disabled for control-plane Git operations.
- Creates an isolated task branch/worktree and persists the exact starting SHA for the life of the run.
- Invokes a locally configured coding CLI with `shell: false`, bounded environment/output/time, and a complete context capsule on every turn.
- Supports optional structured `patch-poller/result-v1` output for `complete`, `continue`, `blocked`, and `failed` turns; clean legacy CLI exits can still complete a first-version run.
- Persists run/context state and resumes trusted `patch-poller/feedback-v1` continuation/cancel feedback without relying on model conversation memory.
- Defers a newer revision of one issue while an older revision is still active.
- Excludes PATCH-POLLER runtime exchange files from project changes and rejects attempts to force them into a candidate.
- Validates Git state and seals all accepted project edits into a clean PATCH-POLLER candidate commit.
- Can optionally push only the dedicated `patchpoller/*` task branch; automatic task-branch push is disabled by default.
- Recovers `verifying`/`publishing` runs by finalizing the already sealed candidate instead of invoking the model again.
- Coalesces bounded/redacted progress and context into GitHub status comments.
- Provides `doctor`, `poll-once`, `run-once`, and `daemon` CLI commands plus a single-instance daemon lock.

## Control-plane rule

PATCH-POLLER owns authoritative run state, managed Git state, capability policy, and publication state. Remote/local LLMs are proposal engines.

Remote task text, repository content, dependencies, model output, and process output are data/proposals. They cannot create executable paths, local paths, environment authority, credentials, or sandbox/network privileges.

## Free GitHub reference deployment

The reference deployment is a GitHub Free personal account. Core correctness and safety do not depend on paid private-repository rulesets/branch protection, Actions, Codespaces, Packages, or other paid features.

Local compilation/testing is the normal path. Optional GitHub features may add defense or convenience but may not become required for the core workflow. Metered features are a separate cost capability and default to no intentional spend.

PAT/fine-grained-token authentication is the implemented v0.1 path. GitHub App installation authentication remains a planned free-compatible isolation improvement.

## Human checkpoints

The normative HITL model is **checkpoint and proceed**, not stop and wait. PP-007 defines non-blocking checkpoints, decision boundaries, hard gates, exact decision subjects, and refactor-pressure behavior.

v0.1 implements durable ordinary continuation/cancel feedback and can record a proposal checkpoint, but it does **not yet** implement the complete `decision-v1`/safe-frontier orchestration. Do not treat a v0.1 model-produced checkpoint object as human authorization.

## Safety default outside the project

PATCH-POLLER does not default to arbitrary read-only access to the whole machine. Read access alone can expose credentials/private files that malicious project code could exfiltrate.

The intended deployment is project read/write plus only required toolchain roots, backed by a verified coding-tool or OS sandbox. v0.1 validates tool sandbox declarations and process-tree/time/output boundaries, but universal OS filesystem/network adapters are not implemented yet. Run v0.1 under a dedicated unprivileged OS account with a minimal home and use the configured coding CLI's own workspace sandbox.

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

## Setup and first run

Requires Node.js 22.16.0 or newer and Git.

1. Copy `config/patch-poller.example.json` to a local configuration file **outside watched project repositories**.
2. Configure `github.queueRepository`, `trustedActorIds`, workspace owners, and `github.tokenEnv`.
3. Configure at least one local coding-tool profile. See `docs/tool-profiles.md`.
4. Keep `execution.enabled` false while reviewing the profile and its real sandbox behavior.
5. Set the GitHub token environment variable for the PATCH-POLLER service account.
6. Run local checks:

```text
node src/cli.js doctor --config <local-config.json>
node src/cli.js poll-once --config <local-config.json>
```

7. Set `execution.enabled` to true and exercise one cycle:

```text
node src/cli.js run-once --config <local-config.json>
```

8. Once the local tool/workspace behavior is correct, run the long-lived loop:

```text
node src/cli.js daemon --config <local-config.json>
```

`publication.autoPushTaskBranches` defaults to false. Enabling it is a standing **local** authorization to push only PATCH-POLLER's dedicated task branches. It does not authorize merge/default-branch/release operations.

Do not commit the real local configuration if it contains machine-specific policy or secret-adjacent values.

## Context and feedback

Every tool turn receives a self-contained `patch-poller/context-v1` capsule with task identity, constraints, decisions/progress, changed files, test reports, Git state, blockers, next step, and bounded output tail.

A blocked structured tool turn enters resumable `waiting-feedback`. Trusted continuation uses a GitHub comment containing exactly one `patch-poller-feedback` envelope bound to the run ID and task revision. Unstructured comments and comments from other actors are ordinary discussion.

## Candidate publication model

The coding tool edits only the isolated worktree. On completion PATCH-POLLER:

1. validates worktree/merge/whitespace/reserved-path invariants;
2. stages the candidate;
3. creates a PATCH-POLLER-owned candidate commit;
4. records the exact candidate SHA;
5. optionally pushes that SHA to its dedicated task branch when local policy enables auto-push.

It does not merge to the default branch or close issues in v0.1.

## Known v0.1 limits

The following are deliberately not represented as complete:

- full PP-007 checkpoint/decision/safe-frontier orchestration;
- OS-level filesystem/network sandbox providers such as dedicated Windows Job/AppContainer or Linux namespace adapters;
- first-class dependency-fetch/install/build/test capability phases from PP-008;
- generic operation journal/reconciliation for every GitHub mutation from PP-009;
- numeric GitHub repository-ID pinning, decision replay journal, baseline instruction snapshots, and tool-version/profile digests from PP-010;
- GitHub App installation authentication;
- webhook task source;
- automatic PR creation/merge/issue closure;
- independent verifier commands outside the coding tool's sandbox.

These are hardening/feature boundaries, not permission for an implementation to silently assume the missing protections exist.

## Engineering documents

- `AGENTS.md` — coding-agent operating rules.
- `docs/design-principles.md` — LEGO / SOLID / CUPID / KISS application.
- `docs/architecture.md` — control plane, ports, trust hierarchy, workspace and CLI model.
- `docs/tool-profiles.md` — safe local CLI profile patterns, including current Codex guidance.
- `specs/PP-001-system.md` — system contract, authority, and lifecycle.
- `specs/PP-002-task-protocol.md` — task transport and revision identity.
- `specs/PP-003-security.md` — filesystem, process, network, secret, capability, and recovery policy.
- `specs/PP-004-github-budget.md` — API/plan/cost behavior.
- `specs/PP-005-context-handoff.md` — durable model context, decisions, and handoffs.
- `specs/PP-006-feedback.md` — trusted continuation/cancel feedback.
- `specs/PP-007-human-checkpoints.md` — checkpoint-and-proceed HITL, decision boundaries, and hard gates.
- `specs/PP-008-git-supply-chain.md` — Git/package/build supply-chain execution boundary.
- `specs/PP-009-effects-recovery.md` — durable effects, crash recovery, and reconciliation.
- `specs/PP-010-provenance-control-channels.md` — origin/provenance roles, replay resistance, and identity hardening.
- `docs/roadmap.md` — implementation/hardening slices and completion gates.

## Tests

```text
npm test
```

The v0.1 suite covers 35 Node tests, including the original protocol/security/rate/context boundaries plus real local Git worktree provisioning, candidate sealing, immutable baseline recovery, process execution, daemon locking, feedback resumption, finalization recovery, active-revision deferral, and a complete local task -> coding CLI -> sealed Git commit acceptance path.

## License

AGPL-3.0-only. See `LICENSE`.
