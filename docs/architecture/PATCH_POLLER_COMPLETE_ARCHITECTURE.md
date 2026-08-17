# PATCH-POLLER Complete Architecture

## 1. System purpose

PATCH-POLLER provides bounded local capabilities to a remote controller that can write GitHub comments but cannot directly access the local machine. GitHub is the durable mailbox; the local daemon remains the sole owner of local trust policy, credentials, paths, tools, workspaces, and side effects.

The design favors outbound polling because it works behind NAT/firewalls and does not require exposing a local listener. Polling is treated as a scarce shared-resource problem, not as an unconstrained timer loop.

## 2. Architectural north star

```text
Controller / primary Sol
  owns: objective, architecture, constraints, review, continuation

GitHub mailbox
  owns: durable transport and human-visible state

PATCH-POLLER
  owns: trust validation, resource governance, bounded local execution,
        progress, recovery, evidence, and handoff

Local CLI adapters
  own: tool-specific invocation and progress decoding
```

No lower layer may silently assume a higher layer's policy authority.

## 3. LEGO bricks

### 3.1 GitHub Mailbox

Reads candidate comments and creates or updates one lifecycle report comment per dispatch. It exposes domain messages and conditional-cache metadata through a port; it does not decide trust or execute work.

### 3.2 Rate-Budget Governor

Serializes every GitHub request for one credential identity. It tracks primary-limit headers, secondary-limit backoff, endpoint ETags, `x-poll-interval`, mutation spacing, request purpose, and a reserved terminal-report budget. No adapter may call GitHub outside this governor.

### 3.3 Dispatch Intake

Extracts the exact protocol marker, bounds the payload, parses strict JSON, validates the versioned schema, computes a digest, and emits a candidate dispatch. It ignores prose outside the envelope.

### 3.4 Trust Policy

Authenticates the source repository/mailbox, author identity or app identity, author association where configured, dispatch expiry, context monotonicity, replay state, target repository, and requested capability subset. It returns either an accepted immutable dispatch or a bounded rejection reason.

### 3.5 Durable State

Persists endpoint cache validators, comments seen, dispatch claims, lifecycle state, progress sequence, context revisions, report-comment identity, rate observations, jobs, attempts, and recovery metadata. Unique constraints provide replay prevention. The initial adapter uses Node's SQLite API; the port permits replacement.

### 3.6 Context Ledger

Stores bounded typed frames: objective, checkpoint, constraint, decision, evidence, warning, result, and handoff. Every frame records provenance, trust class, sequence, and digest. Prompt assembly clearly separates trusted instructions from untrusted evidence.

### 3.7 Workspace Guard

Resolves only locally configured workspace IDs and relative checkout paths. It proves containment, rejects traversal and unsafe links/reparse points, checks repository identity/branch/head, creates isolated worktrees when required, snapshots pre-state, and audits post-state against allowed paths.

### 3.8 Tool Registry

Maps a dispatch tool ID to a local adapter. Local configuration owns executable resolution, fixed arguments, allowed dynamic arguments, environment allowlist, stdin transport, timeout, output bounds, working-directory policy, progress parser, and declared capabilities. A dispatch can select a registered ID but cannot alter these ownership facts.

### 3.9 Job Orchestrator

Runs the state machine, acquires leases, requests workspace preparation, invokes one tool adapter, consumes progress events, enforces cancellation/timeouts, verifies local effects, optionally commits/pushes through separate capabilities, and produces terminal evidence.

### 3.10 Progress Reporter

Consumes local progress events and decides what is meaningful remotely. It updates one lifecycle comment on state transitions, substantive progress, maximum-silence heartbeat, or terminal state. It coalesces rapid events, redacts content, respects GitHub budget classes, and never lets workers post directly.

### 3.11 Recovery and Handoff

On restart, identifies interrupted leases and resumes only explicitly resumable phases. Otherwise it marks the attempt interrupted and emits a context-complete handoff. It never reruns a claimed dispatch merely because the process restarted.

## 4. Hexagonal layering

```text
src/domain       pure values, invariants, state machines
src/application  use cases and orchestration
src/ports        interfaces owned by the application/domain
src/adapters     GitHub, SQLite, process, filesystem, clock, logging
src/config       local policy loading and validation
src/cli.ts       composition root only
```

Domain and application code must not import `node:child_process`, `node:fs`, `node:sqlite`, HTTP clients, or GitHub-specific response types.

## 5. Dispatch lifecycle

```text
discovered
  -> validating
  -> rejected | accepted
  -> preparing
  -> running
  -> verifying
  -> committing? 
  -> pushing?
  -> completed | failed | blocked | cancelled | interrupted
```

Transitions are persisted before externally visible side effects where possible. Every progress event has a monotonic sequence number. Terminal states are immutable except for an explicit supersession record.

## 6. GitHub API stewardship

### 6.1 Polling

- Poll a stable, narrow issue-comment endpoint for each configured mailbox.
- Authenticate every request.
- Persist and send ETags/Last-Modified validators.
- A `304 Not Modified` is the normal idle outcome.
- Honor `x-poll-interval` as a floor.
- Use adaptive idle backoff with bounded jitter.
- Persist cursors and follow pagination links only when a changed response proves additional pages exist.
- Never poll the rate-limit endpoint as a heartbeat; learn from every normal response header.

### 6.2 Shared budget

One governor covers all repositories using the same credential identity. It tracks `x-ratelimit-resource`, limit, remaining, used, and reset. Work is classified:

- **critical:** terminal result, cancellation acknowledgement, safety warning;
- **normal:** claim/accepted state and material phase transitions;
- **background:** idle polls and optional heartbeats.

Background work yields first as the reserve is approached. Normal progress collapses to terminal-only reporting under pressure. The critical reserve is never spent on cosmetic updates.

### 6.3 Secondary limits

Requests are serial. Mutations wait at least one second apart. `retry-after` wins; otherwise primary reset is obeyed when remaining is zero, and suspected secondary limits back off for at least one minute with exponential growth and a hard retry cap.

## 7. Progress and feedback

Local console feedback is immediate and detailed. GitHub feedback is bounded and meaningful.

The lifecycle report includes:

- dispatch/context identity and payload digest;
- accepted target/tool/capability summary;
- current state and phase;
- step index and last completed checkpoint;
- elapsed time and last meaningful activity;
- bounded output summary or failure evidence;
- rate-budget mode when degraded;
- context continuation frames;
- terminal evidence and handoff.

Rapid command output is never mirrored line by line. Tool adapters may emit structured progress, but only the reporter decides when to spend a GitHub mutation.

## 8. Context continuity

A dispatch carries a bounded context bundle with an ID and monotonic revision. Frames explicitly distinguish:

- trusted controller instructions;
- repository authority references;
- observed evidence;
- untrusted external content;
- prior attempt outcomes;
- handoff facts.

A report repeats the minimum complete continuation bundle. A fresh model window can reconstruct purpose, checkpoint, constraints, evidence, and unresolved blockers without relying on hidden chat memory. PATCH-POLLER does not invent the next task.

## 9. Local execution safety

- Remote input selects only locally registered IDs and schema-approved argument values.
- `spawn` uses structured argv and `shell: false` by default.
- Environment starts from a minimal allowlist, not the complete daemon environment.
- CWD must resolve beneath the configured checkout.
- Tool and process-tree timeouts are mandatory.
- Output is streamed into bounded local storage with bounded tails in reports.
- Read-only dispatches fail if tracked or untracked state changes.
- Write dispatches are audited against exact allowed paths.
- Unexpected changes quarantine the worktree and prevent commit/push.
- Commit and push are separate capabilities, never implied by write access.
- Secrets and absolute sensitive paths are redacted before remote reporting.

## 10. CLI flexibility

Tool adapters implement one port and can represent deterministic commands, build systems, test runners, or agent CLIs. Variability belongs in local configuration and adapter code, not in the dispatch protocol. Progress parsers are optional; an unknown tool still reports process start, periodic liveness, exit, and bounded output.

## 11. Recovery

SQLite uses WAL mode and durable unique claims. A lease records daemon instance, attempt, phase, and expiry. After a crash:

- never re-execute a terminal or already committed side effect;
- inspect the exact local and GitHub state before resuming;
- resume only idempotent phases with explicit proof;
- otherwise emit `interrupted` and a handoff describing the safe operator action.

## 12. Extension rules

A foreseeable extension adds an adapter, policy entry, schema version, progress decoder, or state migration. It must not add product/tool-name conditionals to the orchestrator. New capabilities are deny-by-default and require an active spec plus focused threat review.

## 13. KISS boundary

The first usable release supports one daemon, serialized GitHub I/O, one job at a time by default, registered process tools, one lifecycle comment per dispatch, and SQLite durability. Concurrency, distributed workers, web dashboards, and autonomous planning are excluded until measured need justifies them.
