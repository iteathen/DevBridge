# PATCH-POLLER

PATCH-POLLER is a Windows-first, outbound-only Node.js daemon that uses GitHub issue and pull-request comments as a durable mailbox for narrowly authorized local work.

It exists for workflows where a remote planning/review model can write to GitHub but cannot directly reach the local filesystem or terminal. PATCH-POLLER polls efficiently, validates a versioned dispatch envelope, executes only locally registered capabilities, reports meaningful progress through one coalesced lifecycle comment, and publishes a bounded handoff that a fresh context can resume from.

## North star

```text
Remote controller / primary reviewer = intent, architecture, review, next step
PATCH-POLLER                      = trusted bounded local hands
Local CLI adapters                = replaceable execution mechanisms
GitHub                            = durable bidirectional mailbox
```

PATCH-POLLER is not an autonomous project manager. It does not select issues, invent `next_step`, reinterpret natural-language comments as shell commands, or grant a remote message access beyond local policy.

## Design hierarchy

```text
LEGO -> SOLID -> CUPID -> KISS
```

The daemon is decomposed into replaceable bricks: GitHub mailbox, rate-budget governor, trust policy, durable state, context ledger, workspace guard, tool registry, job orchestrator, progress reporter, and recovery/handoff.

## Core guarantees

- Outbound-only GitHub polling; no inbound port or tunnel is required.
- Authenticated conditional requests with persisted ETags.
- One shared, serialized GitHub request queue and account-conscious budget governor.
- Adaptive idle polling, `x-poll-interval` compliance, jitter, and explicit rate-limit backoff.
- Mutative GitHub requests are serialized and spaced by at least one second.
- One mutable lifecycle report per dispatch; updates are coalesced and terminal state is prioritized.
- Durable replay prevention by GitHub comment ID, dispatch ID, payload digest, and context revision.
- Strict machine-readable envelopes; unstructured comment text is never executable authority.
- Local CLI tools are registered in local configuration. A dispatch names a tool ID, never an arbitrary executable.
- Structured executable/argument invocation with shell interpretation disabled by default.
- Explicit workspace roots, path allowlists, expected Git head guards, timeouts, output limits, and post-run change audits.
- Context frames preserve objectives, checkpoints, constraints, decisions, evidence, and handoffs across model windows.
- Full local event history is durable; GitHub receives bounded, meaningful summaries rather than log spam.

## Status

The bootstrap branch establishes the governing architecture, schemas, and a runnable TypeScript vertical slice. Automatic CI is intentionally absent; release and validation activity remain explicit.

## Requirements

- Node.js `>=24.15.0 <27`
- Git
- A GitHub token or GitHub App installation-token provider with only the permissions required by configured mailboxes
- Windows is the primary qualification target; platform-specific behavior remains behind adapters

## Development

```powershell
npm install
npm run build
npm test
node dist/cli.js --config config/example.config.json
```

Copy `config/example.config.json` outside the repository or replace placeholder paths before running. Never commit tokens or private keys.

## Governing documents

Read in order:

1. `AGENTS.md`
2. `.agents/core-standard.md`
3. `specs/00_READ_FIRST.yaml`
4. `docs/architecture/PATCH_POLLER_COMPLETE_ARCHITECTURE.md`
5. the task-relevant active specs listed in `specs/index.yaml`

## License

AGPL-3.0-only. See `LICENSE`.
