# Architecture

DevBridge is a local daemon/CLI and control plane that watches a narrowly configured GitHub issue queue for trusted structured tasks, owns a managed Git workspace, executes bounded deterministic operations or locally configured proposal workers, verifies candidate state, coordinates human/peer decisions, publishes only through controller-owned Git effects, and persists enough evidence to recover without model conversation memory.

## Current implementation boundary

The current mainline implements the architecture through DB-018. The previously planned managed workspace, durable coordinator, deterministic controller plans, hard decision gates, verified Linux execution sandbox, self-update isolation, exact GitHub provenance, tool inventory/onboarding, context rollover, multi-agent leases/fencing, baseline-drift reverification, and cooperative pause/resource-priority slices are now real control-plane behavior.

The current major boundaries that remain deliberately incomplete are summarized in `docs/roadmap.md`: non-Linux untrusted-code sandbox providers, first-class package-manager/network phases, complete generic remote-effect journaling, per-installation task addressing for shared-team queues, stronger repository/tool identity evidence, hard OS resource quotas/parallel scheduling, and the remaining issue #49 CLI surfaces.

## Control-plane model

DevBridge owns authoritative run state, Git workspace state, capability policy, task provenance, checkpoint/decision state, coordination lease state, verification identity, publication state, runtime-update state, and daemon lifecycle state.

Remote and local LLMs do not own the control plane; they propose work to it. Repository content and subprocess output are also untrusted inputs unless a typed locally controlled adapter deliberately turns a specific observation into evidence.

The primary orchestration path is conceptually:

`TaskSource -> ProvenanceGate -> RunCoordinator -> LeaseGate -> WorkspaceManager -> ControllerPlan/ProposalRunner -> Verifier -> DecisionGate -> Publisher -> Reconciler`

Supporting control-plane services provide state storage, rate budgeting, capability/sandbox admission, worker IPC, tool inventory, context rollover, runtime supervision, and daemon governance.

Events may describe state changes and feed observability, but a durable coordinator and locally owned adapters decide authoritative lifecycle transitions. Hidden callback chains must not become execution authority.

## Authority hierarchy

Authority flows downward:

1. local operator configuration, local control-state keys, and the host OS enforcement boundary;
2. DevBridge's checked-in normative specs and implementation;
3. locally configured delegation to specific numeric GitHub actors for task authorship or decision classes;
4. locally configured trusted coordination peer public keys for lease verification;
5. target-repository instructions such as `AGENTS.md`, which may guide project work but cannot grant machine capability;
6. remote/local LLM output, repository content, web content, dependencies, generated files, tool documentation, and process output, which remain data/proposals.

No lower level can grant itself authority from a higher level.

A remote human decision is not a general override. It is accepted only when local policy delegates every triggered decision class to that actor and the exact current GitHub comment provenance plus run/task/checkpoint/subject identity match.

A coordination peer signature is not task or execution authority. It authenticates lease ownership only.

## Remote task admission and workstation dispatch

GitHub tasks are accepted only when DevBridge can verify the exact current issue-body bytes and trusted edit provenance under DB-002/DB-010. Creator identity alone is insufficient.

`github.trustedActorIds` is a local remote-job-submission allowlist. A trusted actor can request work on repositories already allowed by that runner; the task itself cannot provide local paths, executables, raw argv, environment values, credentials, sandbox exceptions, peer keys, or Git publication authority.

Current task envelopes are not addressed to a cryptographic agent identity. DB-016 prevents two compliant authorized installations from simultaneously owning the same task, but it does not decide which human is allowed to dispatch to which workstation.

Therefore a deployment requiring strict cross-developer workstation isolation must currently enforce it with runner-local queue/trusted-actor policy. A shared repository collaborator list must not automatically become every runner's `trustedActorIds` list. Per-installation dispatch addressing/authorization is remaining roadmap work rather than an implied property of leases.

## Core task flow

1. `TaskSource` polls the configured GitHub queue using conditional authenticated requests and the DB-004 shared rate budget.
2. The GitHub provenance adapter verifies exact issue-body identity and edit authorship before creating a trusted `TaskEnvelope`.
3. Task parsing separates bounded objective/context fields from machine authority. Requested capabilities and preferred tool names are descriptive requests only.
4. If DB-016 coordination is enabled, the daemon acquires or renews the signed task lease with exact Git-ref CAS before execution. Peer-held tasks defer.
5. `RunCoordinator` creates or resumes durable run state and preserves immutable `baseSha` start evidence.
6. `WorkspaceManager` maps `owner/name` into DevBridge-owned repositories/worktrees; tasks never supply a local path.
7. The coordinator chooses either a deterministic controller-plan path or an explicitly enabled proposal/model adapter.
8. Capability admission verifies the exact operation/profile, outer sandbox enforcement, environment/network policy, lease fence, and current daemon/run state before child launch.
9. Worker IPC is projected from a control-owned mailbox outside the proposal worktree. Context bytes are read-only; the pre-created result object is writable in place and revalidated before privileged consumption.
10. Candidate edits are verified against the current publication baseline. Controller-plan persistent outputs receive exact final-byte verification after deterministic operations and cleanup.
11. DB-007 locally classifies sensitive candidate effects. Pending gates do not stop unrelated safe work; matching artifact-exact approval is required before sensitive sealing/publication.
12. DevBridge creates/records the exact candidate commit and verification evidence.
13. Before publication, DB-016 lease ownership and DB-017 exact verified-head identity are rechecked. Publication uses controller-owned Git refs and explicit expected remote state.
14. Ambiguous effects are observed/reconciled before retry. Durable state records the resolved outcome.

## Managed Git/workspace model

DevBridge operates on poller-owned managed repositories and disposable/recoverable worktrees rather than destructively manipulating a developer's casual checkout.

Conceptually:

```text
<workspace-root>/
  repositories/<owner>/<repo>/
  worktrees/<owner>/<repo>/<run-id>/
  runs/<run-id>/
```

Control-owned durable state, worker mailbox state, identity keys, daemon control records, runtime activation state, and chat-handoff state live outside proposal trees under the configured DevBridge state/runtime roots.

A task names a repository (`owner/name`), never a local path. Local policy chooses allowed owners, workspace roots, baseline channels, publication branch prefixes, manifest roots, and other filesystem authority.

DevBridge does not auto-clean/reset an arbitrary existing dirty checkout. Uncertain managed-worktree repair prefers reconstruction/replacement over deleting unexplained Git locks or discarding unknown state.

## Baseline identity and drift

Every run records two distinct baseline concepts:

- `baseSha`: immutable start-of-run evidence;
- `publicationBaseSha`: the exact baseline against which the current candidate is verified for publication.

The active task remains bound to its authorized baseline ref/channel. Only same-ref fast-forward upstream movement may be automatically reconciled. Rewritten history checkpoints instead of silently changing authority.

Successful rebase invalidates prior verification. Model-assisted candidates consume a fresh bounded verification turn; deterministic controller plans replay their registered assertions/operations against the rebased state. Dirty/local-head/publication-baseline drift after verification invalidates evidence again before sealing/publication.

Publication binds the exact verified local head as payload identity and uses explicit expected remote head state. Symbolic `HEAD`, blind force, or unexplained remote branch state are not publication authority.

## Execution architecture

The preferred path is:

`Primary chat controller -> DevBridge -> deterministic local operations -> verify -> seal/publish`

A primary chat controller may author file content, expected outputs, bounded parameters, and execution intent. DevBridge owns materialization, executable selection, argv construction, environment policy, sandbox admission, process lifecycle, cleanup, Git identity, verification, and publication.

Coding-model adapters remain optional compatibility/inference surfaces and are disabled by default in the reference configuration. Do not route deterministic compiler/test/Git/state work through a coding model merely because an adapter exists.

### Deterministic controller plans

DB-013 controller plans are data, not remote shell scripts. They may propose bounded project file changes and invoke locally registered named operations with closed parameter schemas. They cannot provide executables, raw shell/argv, arbitrary local paths, cleanup roots, credentials, network authority, or arbitrary Git refs.

Persistent file proposals are verified by exact normalized bytes after all deterministic operations and scratch cleanup. Operation-generated persistent output is not implicitly authorized through changed-path lists.

### Dynamic tool onboarding

DB-015 lets local operators extend `tool.*` operations without source edits, but observation never creates authority.

PATH discovery is presence-only. Automatic unfamiliar-tool onboarding is disabled by default and requires exact local pre-authorization of the command/help probe. The probe itself runs as untrusted repository-code execution behind the verified OS boundary with network denied and control credentials/state hidden. Help/man/spec output may shape only a bounded non-authority parameter schema. The generated manifest is persisted under an operator-owned manifest root before activation.

## Verified worker/repository-code isolation

A proposal/model worker or repository-controlled operation cannot launch solely because a tool profile claims sandboxing. DevBridge requires a separately observed outer isolation provider.

The current built-in provider is Linux/Bubblewrap. Its admission probe verifies, with harmless control-created sentinels, that:

- project/run-scratch writes work;
- arbitrary outside writes fail;
- unrelated host/control-state reads fail;
- authoritative Git administration is not writable;
- denied network egress is actually denied;
- expected capability dropping/isolation is present.

Worker HOME/TMP are synthetic. Control-plane GitHub/SSH credential channels are stripped. Only explicitly configured non-control service credentials may be inherited by an enabled proposal profile.

Unsupported platforms fail closed for untrusted proposal-worker/repository-code execution. Static inspection/control-plane functionality remains available where safe.

## Human checkpoint-and-proceed control

Human attention is orthogonal to the primary run lifecycle.

A run may continue safe reversible work while an architectural or other consequential decision is pending. Only when the safe frontier is exhausted does it enter `waiting-decision`. Hard-gated effects remain prohibited until matching local delegation and exact decision provenance/subject binding are satisfied.

Sensitive candidate approval is currently artifact-exact for automatic hard gates: changing candidate identity invalidates the prior approval. The exact subject is recomputed before sealing and again before task-branch publication, including restart-from-publishing recovery paths.

Capability expansion is never granted by a decision comment. Local policy remains required for new executable/filesystem/network/credential/sandbox/trust authority.

## Multi-agent coordination and fencing

When coordination is enabled, each installation owns a persistent control-state Ed25519 keypair. Public-key SHA-256 is the stable fingerprint/address; the private key never enters task repositories, worker contexts, process environments, or public status.

Task leases are signed bounded subjects stored behind DevBridge-owned queue-repository refs. Transitions use explicit expected-value Git CAS. Labels/comments may mirror state for humans but are not ownership authority.

Lease TTL/heartbeat lets a trusted peer reclaim crashed ownership after expiry/skew. A definite CAS loss fences immediately; ambiguous renewal does not invent a successor but expires naturally. Fence checks occur before new workers/operations and before sealing/publication, and active children receive an abort signal where the process containment path supports it.

Lease release is a signed CAS state transition rather than blind ref deletion.

## Durable recovery and context rollover

DevBridge treats model/chat context as disposable.

Run state, exact task/baseline/candidate identity, checkpoints, decisions, verification records, effect intent/outcome, cleanup ownership, and next-action evidence live in durable control state.

DB-014 adds bounded `devbridge/chat-handoff-v1` checkpoints for coordinating-chat rollover. Handoffs bind repository/baseline/head/task identity, governing-document digests, stable completed action IDs, one exact next action, and a whole-record SHA-256. Fresh contexts observe/reconcile before acting and do not invent a new next step if the recorded action already occurred.

Large logs/diffs remain behind durable references rather than becoming a transcript dump.

## Runtime supervision and self-update

The bootstrap supervisor is intentionally separate from the mutable daemon runtime.

Development mode follows a mutable testing channel as an explicit alpha risk. Production mode requires a locally trusted signed immutable release subject binding fixed repository identity, exact commit, version, and runtime artifact digest.

Candidate-controlled preflight/tests execute only inside the verified untrusted-code sandbox with control/runtime secrets hidden and network denied. The supervisor rechecks exact artifact identity after validation and at activation. The current daemon drains only after candidate acceptance, then the supervisor activates the exact tested candidate, runs health/doctor, and rolls back to last-known-good on failure.

## Daemon control and workstation governance

The daemon has a token-bound singleton lock. Local `stop`, `pause`, and `resume` records bind to that exact lock owner so stale files cannot control a replacement process.

Pause is cooperative admission control at a safe task-cycle boundary. It does not freeze active threads/processes and therefore does not violate lease heartbeat/fencing semantics. A fully paused daemon performs no routine task polling/claiming. Stop has precedence over pause.

Model/deterministic child processes use below-normal OS priority by default. Failure to apply a requested non-normal priority fails the operation instead of silently degrading to normal priority. Priority is QoS only; it is not a security sandbox or hard resource quota.

Task admission is currently serialized to one active task/run continuation per daemon cycle. Parallel worker scheduling requires a future explicit scheduler/lease/effect accounting contract.

## GitHub and publication authority

GitHub API operations are serialized/rate-budgeted and use persisted conditional validators where applicable. Status/tool-inventory/handoff projections are bounded, redacted, and coalesced rather than treated as a free event stream.

Control-plane Git operations run outside proposal-worker authority under hardened environment/config rules. Automatic task-branch publication is separately locally authorized and disabled by default.

DevBridge does not treat ordinary task text as authority to merge the default branch, force arbitrary refs, release/tag/deploy, or close issues. Those remain separate locally controlled effect classes.

## Documentation authority

`specs/DB-001-system.md` through `specs/DB-018-runtime-governance-pause.md` are the current normative contracts. `AGENTS.md`, this architecture document, `docs/bootstrap.md`, `docs/tool-profiles.md`, and `docs/roadmap.md` describe the current operating/engineering view.

`docs/handoffs/` and point-in-time testing audits are historical evidence. They intentionally preserve the state that existed when written and do not override newer specs/mainline behavior.
