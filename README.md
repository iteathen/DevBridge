# PATCH-POLLER

PATCH-POLLER is a local Node.js control plane that turns narrowly trusted GitHub tasks into bounded development work on a locally controlled machine. It owns task provenance, managed Git state, execution authority, durable run state, verification, human decision gates, coordination leases, publication, runtime supervision, and recovery. Remote/local LLMs and repository code remain subordinate proposal/code inputs.

## Current status

The current `main` line implements the architecture through PP-018, including the security/capability campaign and the first issue #49 multi-agent/runtime-governance slices.

PATCH-POLLER is usable for general local operation on verified Linux hosts, but it is still pre-production software. The most important current platform boundary is unchanged: untrusted proposal-worker or repository-code execution requires a verified outer OS sandbox. The built-in verified provider is Linux/Bubblewrap; unsupported hosts fail closed for those execution classes instead of silently running them with host authority.

Implemented on current main:

- exact trusted GitHub task, feedback, and decision provenance using numeric actor IDs plus edit-history verification;
- managed repository/worktree ownership, hardened Git invocation, candidate sealing, task-branch publication, and restart-safe recovery;
- PP-007 artifact-exact hard gates for sensitive candidates before sealing and publication;
- deterministic controller plans and locally registered deterministic operations, with model adapters optional and disabled by default;
- exact final-byte re-verification after operations/cleanup before a controller-plan candidate may seal;
- verified Linux Bubblewrap containment for proposal workers, repository-controlled build/test operations, and self-update candidate validation;
- control-owned worker IPC outside proposal worktrees, with exact mailbox identity/digest checks;
- signed immutable production self-update subjects, isolated candidate validation, safe daemon drain, health checks, and last-known-good rollback;
- sanitized local tool inventory, bounded capability projection, and locally pre-authorized sandboxed dynamic `tool.*` onboarding;
- durable coordinating-chat rollover and fresh-context recovery under PP-014;
- persistent Ed25519 installation identity, signed task leases, expected-SHA Git-ref CAS, heartbeat/TTL recovery, fencing, and agent-namespaced candidate branches when coordination is enabled;
- immutable start-baseline evidence plus a separate publication baseline, fast-forward-only automated rebase, mandatory post-drift reverification, and exact verified-head publication CAS;
- cooperative daemon `pause`/`resume` at safe task-cycle boundaries;
- below-normal child-process priority by default for model workers and deterministic operations;
- serialized task admission: effective task concurrency is currently one even if a larger `execution.maxConcurrentTasks` value is configured.

## Control-plane rule

PATCH-POLLER is the single source of machine authority.

Remote task text, repository content, dependencies, model output, tool documentation, and process output are data/proposals. They cannot create an executable path, shell command, local filesystem root, environment secret, credential source, network capability, sandbox exception, trusted actor, peer key, Git ref authority, or human-decision authority.

A task may request work and descriptive capabilities. Local operator policy decides what is actually allowed.

## Remote task authors and workstation security

`github.trustedActorIds` is a **remote development-job submission allowlist**, not a generic repository-collaborator list.

If a runner has `execution.enabled: true` and trusts a GitHub actor, that actor can submit a valid PATCH-POLLER task that causes development code to run on that runner, subject to the runner's local tool/capability/sandbox policy. The task protocol does not permit arbitrary shell/argv/path/environment injection, but trusted task authors should still be treated as people allowed to request local development work.

Multi-agent coordination does not change this rule. PP-016 leases coordinate which authorized installation owns a task; a peer key is not task authority, and a lease is not execution authority.

Current task envelopes do **not** contain a cryptographically bound destination-agent address. Therefore, a deployment that requires developer A to be unable to dispatch work to developer B's workstation must enforce that separation through each runner's local queue and `trustedActorIds` policy today. Do not configure a shared team actor allowlist merely because everyone is a repository collaborator. Per-installation dispatch addressing/authorization remains a roadmap item in issue #49.

## Task protocol

A task issue contains exactly one top-level machine envelope:

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

The protocol deliberately has no task-controlled `command`, `shell`, `cwd`, `localPath`, `executable`, raw environment, credential, sandbox, Git-ref, peer-key, or daemon-control fields.

Task authority is accepted only when PATCH-POLLER can verify the exact current issue-body bytes and complete trusted edit provenance. Creator identity alone is insufficient.

## Repository-code and proposal-worker sandbox boundary

PATCH-POLLER does not default to read access across the host. Read-only host access can expose SSH keys, cloud credentials, browser profiles, tokens, and private documents that malicious code could exfiltrate through allowed output.

Deterministic operations are classified as static inspection, trusted control work, or repository-code execution. Repository-code operations and proposal/model workers cannot launch unless the active outer isolation provider has passed PATCH-POLLER's live boundary probe.

On Linux the built-in Bubblewrap provider:

- exposes the managed proposal project and current run scratch as the ordinary writable roots;
- keeps authoritative `.git` administration read-only or unreachable from untrusted execution;
- exposes only required system/tool roots and explicitly configured external read roots as read-only;
- uses synthetic private HOME/TMP locations;
- hides PATCH-POLLER control state, daemon control files, SSH/GitHub credential directories, and unrelated operator-home paths;
- strips control-plane GitHub/SSH credential environment channels;
- can enforce denied or explicitly unrestricted worker networking; unsupported requested network modes fail closed;
- verifies its actual filesystem/network/control-state boundary before admission.

`doctor` separates profile declarations from configured provider identity and observed enforcement. A profile saying `sandbox.enforcement: "os"` or `"tool"` does not itself prove containment.

Windows and other hosts without a verified provider remain usable for static/control-plane operations, but untrusted proposal-worker and repository-code execution fail closed there.

## Human checkpoints and hard gates

PP-007 uses **checkpoint and proceed**, not a blanket stop-and-wait model.

PATCH-POLLER may continue reversible work inside the current capability/decision envelope while a consequential decision is pending. It enters `waiting-decision` only when the safe frontier is exhausted.

Sensitive candidates are classified locally. Remote decision authority for a class exists only when local configuration lists the actor under `execution.decisionAuthorities` for every triggered class. Artifact-sensitive approval binds to the exact candidate subject and is rechecked before sealing and task-branch publication. Silence, expiry, stale IDs, changed artifacts, or ambiguous provenance never become approval.

Remote decisions cannot grant new filesystem roots, executables, credentials, network authority, sandbox exceptions, peer trust, or other capability expansion.

## Multi-agent coordination

Coordination is disabled by default.

When enabled, each installation owns a persistent local Ed25519 keypair. The public-key SHA-256 fingerprint identifies the installation; the private key remains control-plane state.

Task ownership uses signed `patch-poller/task-lease-v1` subjects stored behind PATCH-POLLER-owned Git refs. Lease transitions use exact expected-value Git CAS (`--force-with-lease=<ref>:<expected-sha>` semantics), not issue-label races or blind force pushes.

An unexpired trusted-peer lease defers the task. Expired trusted-peer leases may be reclaimed only after the configured skew margin. Lost/expired ownership fences new work and later sealing/publication effects, and active child execution receives the lease-loss abort signal where supported.

A lease grants coordination authority only. It does not grant task trust, repository access, executable authority, credentials, sandbox authority, human-decision authority, or publication permission.

## Baseline drift and exact publication identity

Every run preserves an immutable `baseSha` as start-of-run evidence and tracks a separate `publicationBaseSha` for the candidate currently being verified.

PATCH-POLLER automatically reconciles only same-ref fast-forward upstream movement. Rewritten upstream history checkpoints instead of being silently accepted. Successful rebase invalidates earlier verification and requires bounded fresh verification/replay before publication.

Task-branch publication is bound to the exact locally verified head, not symbolic `HEAD`. First publication and any later rewrite require explicit expected remote state, and ambiguous publication is reconciled by re-observing the remote head rather than force-overwriting unexplained state.

## Daemon runtime governance

The supported CLI currently includes:

```text
patch-poller doctor
patch-poller poll-once
patch-poller run-once
patch-poller daemon
patch-poller status
patch-poller pause
patch-poller resume
patch-poller stop
patch-poller restart
patch-poller handoff-status
patch-poller handoff-seed
patch-poller handoff-project
```

`pause` is cooperative admission control, not `SIGSTOP` or thread suspension. A request binds to the exact daemon lock token, is acknowledged at the next safe task-cycle boundary, prevents another polling/admission cycle, and preserves run/worktree/IPC/lease evidence. `stop` has precedence over pause.

Model and deterministic child processes run below normal OS priority by default. This is workstation QoS, not a security sandbox or CPU/memory quota. Hard CPU, memory, disk-growth, descendant-count, and arbitrary native-thread quotas remain future resource-provider work.

The daemon currently admits one task/run continuation at a time. A larger configured `maxConcurrentTasks` value does not create a worker pool.

## Bootstrap and self-update

`patch-poller.mjs` is the supported launcher for a machine with Node.js 22.16.0+ and Git.

Development mode follows the mutable testing channel and is explicitly alpha. Production mode requires a locally trusted Ed25519-signed release manifest binding repository identity, exact commit, version, and platform-neutral runtime artifact SHA-256. Candidate preflight/tests execute only inside the verified untrusted-code sandbox; the artifact digest is recomputed after validation and again checked before activation. Failed validation/activation/health leaves or restores the last-known-good runtime.

See `docs/bootstrap.md` for the exact production release subject and supervisor lifecycle.

## Setup

1. Copy `config/patch-poller.example.json` to a local configuration file **outside watched project repositories**.
2. Set `github.queueRepository`, `github.trustedActorIds`, allowed workspace owners, and authentication policy.
3. Keep `execution.enabled` false while reviewing machine authority and sandbox behavior.
4. If using model adapters, configure only the required local tool profiles and credentials; model adapters are disabled by default.
5. If enabling coordination, configure the local handle, lease timing, and exact trusted peer public keys. Coordination is not task authorization.
6. Run:

```text
node src/cli.js doctor --config <local-config.json>
node src/cli.js poll-once --config <local-config.json>
```

7. Before enabling any untrusted execution on Linux, require the appropriate `doctor` enforcement records to report a verified Bubblewrap boundary. Do not bypass the gate on an unsupported/misconfigured host.
8. Set `execution.enabled` to true only after reviewing the local task-author, tool, decision, publication, and coordination authority.
9. Exercise `run-once`, then start the long-lived daemon/supervisor when the local policy is correct.

`publication.autoPushTaskBranches` defaults to false. Enabling it is a standing local authorization to publish PATCH-POLLER task branches under the configured branch prefix; it is not default-branch merge/release authority.

## Current limitations / remaining roadmap

The following are intentionally not represented as complete:

- per-installation task destination/dispatch authorization for shared-team queues; use runner-local `trustedActorIds`/queue separation when cross-developer workstation isolation is required;
- verified OS sandbox providers for Windows and other non-Linux hosts;
- first-class dependency fetch/install/browser capability phases and package-manager lifecycle-script isolation from PP-008;
- complete generic effect journaling/reconciliation for every possible remote mutation; current critical run/publication/update paths have targeted durable reconciliation;
- numeric GitHub repository-ID pinning/rename-transfer reconciliation and complete tool/profile identity evidence;
- GitHub App installation authentication;
- hard OS CPU/memory/disk/process-count/thread quotas beyond current below-normal process priority;
- parallel task admission/scheduling; effective concurrency is one;
- issue #49 CLI surfaces not yet implemented, including `whoami`, peer administration, lease inspection/manual claim/recovery, local issue dry-run, and local patch verification commands;
- optional webhook task source;
- automatic default-branch merge, release/tag/deployment, or issue closure as ordinary task effects.

These are explicit boundaries, not permission to infer or silently emulate the missing authority.

## Documentation map

Live normative/operator documents:

- `AGENTS.md` — coding-agent operating rules and spec-reading map.
- `docs/design-principles.md` — LEGO / SOLID / CUPID / KISS application.
- `docs/architecture.md` — current control plane, trust hierarchy, execution, coordination, and recovery model.
- `docs/bootstrap.md` — current supervisor/update/release-integrity behavior.
- `docs/tool-profiles.md` — local proposal-worker profiles and observed sandbox enforcement.
- `docs/roadmap.md` — current implemented state and remaining work.
- `specs/PP-001-system.md` through `specs/PP-018-runtime-governance-pause.md` — normative contracts.

Historical evidence:

- `docs/handoffs/` contains immutable point-in-time handoffs; checksum-bound files are history, not current authority.
- `docs/testing/` contains point-in-time audit evidence; read it with the current specs/roadmap rather than as a live status document.

## Tests

```text
npm test
```

CI additionally runs focused security, sandbox, coordination, baseline-reverification, and runtime-governance boundary suites on the applicable platforms. Linux CI requires the real Bubblewrap boundary test; unsupported-platform behavior is tested fail-closed.

## License

AGPL-3.0-only. See `LICENSE`.
