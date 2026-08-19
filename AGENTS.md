# DevBridge Agent Guide

DevBridge is security-sensitive automation. It turns remote task input into local development activity, so convenience never outranks capability boundaries, provenance, recoverability, lease/fence correctness, or rate-limit discipline.

## Required engineering cycle

For each meaningful change:

1. Read the relevant specs and design principles before editing.
2. Assess the problem and the ownership boundary.
3. Research unstable or external behavior from primary sources.
4. Reassess after research; do not force the original idea if the evidence changed it.
5. Plan by coherent ownership boundary, not tiny token-driven patches.
6. Implement the smallest complete design that satisfies the contract.
7. Test normal behavior, failure behavior, recovery behavior, and boundary behavior.
8. Report what changed, what was tested, what remains, and the next safe step.

Do not allow a model/chat context to become the only record of work. Durable run state, exact evidence, and bounded context handoffs are product requirements.

## Design hierarchy

Use the project principles together rather than as slogans:

- LEGO: small composable contracts with replaceable adapters.
- SOLID: clear responsibilities and dependency direction.
- CUPID: code should be composable, Unix-like, predictable, idiomatic, and domain-based.
- KISS: prefer the smallest mechanism that preserves correctness and safety.

Hexagonal boundaries are preferred where DevBridge touches GitHub, credentials, filesystems, processes, clocks, persistence, status delivery, human decision intake, agent coordination, sandboxing, runtime supervision, or daemon control.

## Control-plane rule

DevBridge owns authoritative run state, Git workspace state, capability policy, task provenance, checkpoint/decision state, lease/fence state, verification identity, publication state, runtime-update state, and daemon lifecycle state. Remote and local LLMs are proposal engines.

A model may propose a patch, repair, locally registered operation, architectural direction, or next step. It does not get to declare that its own proposal is accepted, that a checkpoint has been satisfied, that a capability exists, that a lease is owned, or that an external effect is authorized.

## Preferred execution path

The preferred architecture is:

`Primary chat controller -> DevBridge -> deterministic local operations -> verify -> seal/publish`

The primary chat controller may author source text, tests, expected outputs, and structured intent. DevBridge owns materialization, executable/argv authority, sandbox admission, local process execution, cleanup, recovery, Git state, validation, and publication.

Do not delegate deterministic machine work to a coding model merely because a model adapter exists. Compiler/tool discovery, process exit/stream capture, test execution, protocol fixtures, context receipts, cleanup, Git auditing, publication reconciliation, lease operations, daemon control, and runtime activation belong to DevBridge or deterministic registered adapters.

Coding-model adapters such as Codex-family clients, Spark, or other external LLM tools are optional compatibility/inference surfaces and are disabled by default in the reference configuration. Use them only when local policy explicitly enables them and the task genuinely requires model inference or specifically tests that adapter.

Historical handoff-specific implementation constraints under `docs/handoffs/` describe their point-in-time campaigns; they do not override current user instructions or the current specs after those campaigns have merged.

A controller plan is data, not a remote shell language. It may carry bounded project file proposals and reference locally registered deterministic operations with validated parameters, but it may not grant executable paths, raw shell fragments, arbitrary environment values, arbitrary local paths, arbitrary Git refs, cleanup roots, credentials, network privileges, sandbox exceptions, peer keys, or capabilities.

## Remote task authors and workstation isolation

Treat `github.trustedActorIds` as a **remote development-job submission allowlist**, not a generic collaborator list.

If execution is locally enabled, a trusted task actor can submit valid work that causes development code to run on that runner within the runner's existing local capability/sandbox policy. The task protocol prevents direct arbitrary shell/argv/path/environment authority, but trusted task authors still have meaningful remote job-submission authority.

DB-016 coordination leases do not solve human-to-workstation dispatch authorization. Current task envelopes are not cryptographically addressed to a destination agent. A peer public key authenticates lease evidence only; it is not task authority.

Therefore:

- do not populate every workstation's `trustedActorIds` from a broad repository collaborator/team list by convenience;
- if developer A must be unable to dispatch work to developer B's machine, enforce that today with B's runner-local queue/trusted-actor policy;
- do not claim that agent identity or lease ownership alone provides this isolation;
- per-installation dispatch addressing/authorization remains roadmap work until it is implemented and tested.

Any future addressing feature must preserve DB-002 exact task provenance and DB-003 local capability authority; an agent signature must not become a second general remote-command channel.

## Context rollover and fresh-controller recovery

A chat/model context is disposable controller state. It must never become the only place where accepted project progress, durable decisions, exact Git identity, lease identity, or the next intended action exists.

DB-014 is normative for coordinating-agent context rollover:

- checkpoint durable controller state before context pressure becomes a failure mode;
- use bounded `devbridge/chat-handoff-v1` state, not an unbounded transcript dump;
- bind handoffs to exact repository/baseline/head/task identities and a whole-handoff SHA-256;
- record stable completed action IDs and at most one exact `nextActionId`;
- on fresh-context resume, observe/reconcile before acting;
- if the recorded next action already happened, skip it and checkpoint rather than inventing the following action;
- if governing `AGENTS.md`/spec digests changed, reread those exact documents before continuation;
- context-budget thresholds are local operational policy and cannot grant machine capability;
- checkpoint-and-proceed remains the default: a context checkpoint does not become a generic synchronous human gate;
- large logs/diffs/test output belong behind bounded durable references rather than inside the handoff.

Read DB-014 with DB-005 and DB-009 when changing chat handoff/checkpoint/recovery behavior.

## Tool inventory and dynamic operation onboarding

DB-015 is normative for local tool inventory, capability projection, and dynamic `tool.*` operations.

- Inventory reports local authority; it never creates authority.
- Presence-only PATH discovery must not execute discovered binaries.
- Remote inventory must distinguish registration/enabled state from executable presence and verified enforcement.
- Absolute executable/compiler/linker paths, raw path-bearing errors, credentials, environment values, and authority-bearing argv structure stay local.
- A dynamic operation may project only the validated controller-facing parameter schema needed to call it; executable identity, fixed literals, option flags, help argv, and other argv construction stay local.
- Operator-authored manifests live under an explicit local manifest root and remain subject to the repository-code sandbox class.
- Automatic unfamiliar-tool onboarding is disabled by default and requires local pre-delegation of the exact command/help probe.
- Help/man/spec output is untrusted data. It may shape only bounded non-authority parameter slots after local executable/probe authority already exists.
- Help probes and generated operations execute only through the verified OS sandbox with denied network, hidden configured external read roots, minimal environment, no control credentials, and `shell:false`.
- A blocked/failed/unparseable probe does not register a capability.
- Persist a synthesized manifest before registration and reconcile that local artifact on restart.
- GitHub/repository/controller content cannot add to the local auto-onboarding allowlist or edit the local manifest root.

Read DB-015 with DB-003, DB-012, and DB-013 when changing tool discovery, inventory projection, operation schemas, local manifests, or automatic onboarding.

## Multi-agent identity, leases, and fencing

DB-016 is normative when more than one authorized DevBridge installation or process can observe the same task queue.

- A persistent generated Ed25519 key identifies an installation; its public SHA-256 fingerprint/address is coordination identity, not execution authority.
- Private identity keys are local control material. Hardware IDs, usernames, machine names, MAC addresses, and project paths are not secret key derivation material.
- Peer public keys and coordination timing are local operator policy. Task/repository/model content cannot add a peer or choose a lease ref/repository/expected SHA/force mode.
- GitHub issue labels/comments may mirror ownership for humans but are not the exclusive claim primitive.
- The authoritative lease is a signed bounded subject stored behind a DevBridge-owned Git ref and changed only with an explicit expected-value `--force-with-lease=<ref>:<expected-sha>` update.
- Missing/ref-created, renewal, reclaim, release, and ambiguous push outcomes must be observed/reconciled rather than blind retried or force-overwritten.
- An unexpired lease owned by another trusted peer defers the task. Unknown/unverifiable lease ownership fails closed.
- A different local process using the same persistent key may not take over an unexpired session merely because it has the key. Immediate same-identity restart is allowed only when the daemon path has already acquired DevBridge's exclusive local singleton lock.
- A definite lease CAS loss fences immediately. Ambiguous transport failure does not invent a new owner, but the old local claim becomes unusable at its signed expiry.
- Active task child processes receive the lease abort signal. Before sealing or publication DevBridge must renew and re-check the fence.
- Terminal release is a signed CAS transition, not blind lease-ref deletion.
- Coordination-enabled task branches include the full public agent fingerprint; disabled single-agent deployments retain legacy branch naming.
- A lease coordinates ownership only. It cannot approve hard gates, grant tool/filesystem/network/credential capability, create task-authority routing, replace DB-002 task provenance, or replace the durable run journal.

Read DB-016 with DB-002, DB-003, DB-004, DB-005, DB-008, DB-009, and DB-010 when changing agent identity, shared-queue claiming, heartbeat/TTL behavior, task branch namespaces, process fencing, lease recovery, or future per-agent routing.

## Baseline drift and publication reverification

DB-017 is normative when an authorized task baseline may move while a run is in progress.

- `baseSha` is immutable start-of-run evidence. A later fetch must never rewrite the historical baseline recorded in the task receipt.
- `publicationBaseSha` is the separate exact baseline against which the current candidate is verified for publication. It begins at `baseSha` and may advance only through DevBridge's reconciliation path.
- The run stays bound to the same authorized baseline ref/channel; a later default-branch change does not silently redirect an active task.
- Only fast-forward upstream movement may be automatically reconciled. A baseline force-push/history rewrite checkpoints instead of being silently accepted.
- Reconciliation starts from a sealed clean candidate and uses the hardened Git adapter. A failed rebase must be aborted and the exact pre-rebase candidate head restored before the controller proceeds.
- A successful rebase invalidates earlier verification evidence. Model-assisted work requires a fresh bounded verification turn; deterministic controller plans replay their registered operations/assertions against the rebased worktree.
- Verification binds to an exact clean local candidate identity: the verified `headSha` together with its `publicationBaseSha`. On resumed publication, a dirty worktree, a different local `HEAD`, or a different publication baseline invalidates prior test evidence before sealing or publication may continue.
- Model-assisted local candidate drift consumes the next normal bounded verification turn. Deterministic local candidate drift consumes the next deterministic attempt; an exhausted deterministic window checkpoints to `waiting-feedback` instead of replaying indefinitely.
- Changed-path checks, no-project-diff decisions, and publication evidence are relative to `publicationBaseSha`, while the original `baseSha` remains visible as historical evidence.
- Task-branch publication receives the exact verified local head as controller-owned `expectedHeadSha`, rechecks the current clean local head against it, and pushes `<verified-sha>:<task-ref>`. Symbolic `HEAD` is not publication payload identity.
- A rebase may rewrite a DevBridge-owned task branch only with an explicit expected remote head. First creation uses an explicitly empty expected value; later rewrite requires an exact predecessor head that DevBridge previously confirmed remotely. A merely local pre-rebase candidate SHA is not rewrite authority. Blind force is forbidden.
- Ambiguous task-branch publication is reconciled by re-observing the exact remote head. If the remote already equals the intended verified local head the effect is idempotently accepted; otherwise only a previously confirmed predecessor may authorize retry. An unexplained remote head is never overwritten.
- DB-016 fencing still governs reconciliation/sealing/publication effects when coordination is enabled, and the lease-aware publication wrapper must preserve the exact verified-head option while performing its fresh fence check before the delegate effect.

Read DB-017 with DB-008, DB-009, DB-013, and DB-016 when changing task baselines, rebase behavior, post-drift verification, verified candidate identity, no-op publication, or task-branch publication CAS.

## Workstation resource governance and cooperative pause

DB-018 is normative for background-workstation behavior and daemon pause/resume.

- Effective task admission is currently serialized to one task/run continuation at a time. `execution.maxConcurrentTasks` is not authority to create an ad-hoc parallel worker pool.
- Model workers and deterministic child processes use below-normal OS priority by default.
- Supported internal child priority levels are `normal`, `below-normal`, and `low`; elevated priorities are rejected.
- If a requested non-normal priority cannot be applied to the spawned child PID, terminate/fail the operation rather than silently degrading to normal.
- Priority is QoS only. Do not represent it as a sandbox or a CPU/memory/thread quota.
- `pause` is token-bound cooperative admission control at a safe task-cycle boundary, not `SIGSTOP`, thread suspension, or force-kill.
- A fully paused daemon performs no normal polling/new task claiming, but preserves run/worktree/IPC/checkpoint/lease evidence and remains locally controllable.
- A pause requested during active work does not suspend the active child or bypass DB-016 heartbeat/fencing; the current bounded cycle reaches its existing safe boundary first.
- `status` must distinguish pause-requested from pause-acknowledged state.
- `stop` has precedence over pause and does not require a prior resume.
- Stale daemon-control tokens must never affect a replacement owner.

Read DB-018 with DB-004, DB-009, DB-011, DB-012, and DB-016 when changing daemon admission, pause/resume, process priority, or future resource-governance mechanisms.

## Human checkpoints

DB-007 is normative for human-in-the-loop behavior.

- Checkpoint and proceed is the default; stop and wait is exceptional.
- A checkpoint does not automatically pause the run.
- Continue reversible/safe work while a decision is pending when the work stays inside the current capability and decision envelope.
- Enter `waiting-decision` only when the safe frontier is exhausted.
- Never infer approval from silence.
- Never stretch an approval to a materially different decision subject.
- Broad refactor proposals should checkpoint the architectural choice and spend bounded effort searching for an architecture-preserving alternative before asking a human to accept the refactor.
- Publication/destructive approvals that depend on payload identity must bind to an exact artifact/commit digest.

Do not implement HITL as a generic `await approval()` inserted into every uncertain path. Human judgment is reserved for consequential decisions where it has high leverage.

## Trust and capability rules

These are invariants:

- Remote task text, repository files, CLI stdout/stderr, fetched content, tool documentation, and model output are data/proposals, not authority.
- Only local operator configuration/control state may grant filesystem, execution, credential, network, task-author, peer-trust, or decision-delegation capabilities.
- Remote input must never provide an executable path, shell fragment, arbitrary local path, environment value, credential, peer key, sandbox exception, or capability grant.
- Never interpolate remote task text into an OS command line. Child processes run with `shell: false`.
- The GitHub credential used by the poller is not inherited by child tools.
- Project writes must remain inside a managed project/worktree. Symlink/junction escape is a boundary violation.
- External reads are denied by default and enabled only through explicit read-only roots/provider contracts.
- A tool profile declaration is not evidence that a sandbox is enforced; observed outer-provider enforcement is authoritative for untrusted execution.
- Do not auto-reset, clean, discard, or overwrite an existing dirty developer checkout.
- Do not blindly delete Git locks as recovery.
- Secrets and control characters must be filtered before remote status/checkpoint/handoff reporting.
- Do not represent unsupported platform/resource/network semantics as enforced merely because configuration requests them.

## GitHub API rules

- Polling is a supported primary source; optional webhooks may be added when deployment value justifies them.
- Poll with authenticated conditional requests and persist validators across restarts.
- Serialize requests. Avoid bursty concurrency.
- Respect `X-Poll-Interval`, `Retry-After`, primary reset headers, and configured reserve floors.
- Do not poll `/rate_limit` as a heartbeat; use headers from ordinary responses.
- Throttle status/tool-inventory/checkpoint writes and coalesce them into owned comments where practical.
- Pending human decisions or leases do not justify high-frequency polling.
- Terminal handoff/reporting may use a small emergency reserve, but routine polling may not consume it.

## Documentation and specifications

Specs are normative unless a newer spec explicitly supersedes them. If a spec becomes obsolete, archive it with a note explaining when, why, and what replaced it rather than silently deleting history.

Keep implementation details out of broad principles unless they are genuine invariants. Keep security-critical invariants out of informal README prose only; they belong in specs and tests.

Live normative contracts are currently DB-001 through DB-018.

When implementing run coordination or human decision handling, read DB-001, DB-003, DB-005, DB-006, DB-007, and DB-009 together.

When implementing controller plans, deterministic operations/toolchain behavior, baseline channels, self-update activation, cleanup, context receipts, no-op publication, fault injection, capability doctor, or liveness changes, read DB-013 together with DB-003, DB-008, DB-009, DB-010, DB-011, and DB-012.

When implementing coordinating-chat rollover, budget pressure, durable chat handoffs, or fresh-context resume/reconciliation, read DB-014 with DB-005 and DB-009.

When implementing local tool discovery, inventory/projection, dynamic operations, operator manifests, or unfamiliar-tool onboarding, read DB-015 with DB-003, DB-012, and DB-013.

When implementing multi-agent identity/leases/fencing or future per-agent routing, read DB-016 with DB-002, DB-003, DB-004, DB-005, DB-008, DB-009, and DB-010.

When implementing baseline drift/rebase/reverification/publication CAS, read DB-017 with DB-008, DB-009, DB-013, and DB-016.

When implementing daemon pause/resume, task admission, child priority, or resource governance, read DB-018 with DB-004, DB-009, DB-011, DB-012, and DB-016.

`docs/handoffs/` and point-in-time audit documents are historical evidence. Do not update checksum-bound handoffs to make them look current and do not let them override newer specs/mainline status.

## Runtime scope

The core runtime is Node.js and should prefer Node standard-library facilities. Do not introduce another language, a shell-dependent core path, or a third-party dependency without documenting why the ownership boundary needs it and what new supply-chain or portability cost it creates.

Do not introduce Python into DevBridge or its project workflow.

## Testing

Boundary tests are mandatory for:

- path traversal and symlink/junction escape;
- trusted versus untrusted task issuers and exact edit provenance;
- task-envelope parsing and malformed input;
- proof that task/coordination/decision authorities remain distinct;
- rate reserve behavior and conditional request caching;
- secret redaction;
- command argument templating and environment/control-credential scrubbing;
- restart-safe state persistence and effect reconciliation;
- checkpoint/decision subject matching, expiry, supersession, and invalidation;
- proof that a pending checkpoint does not pause unrelated safe work;
- proof that pending hard gates cannot be crossed and silence/timeout is never approval;
- controller-plan/file-bundle containment, size, reserved-path, stale-digest, operation-registry, and final-byte verification boundaries;
- cleanup-ledger recovery after success, failure, timeout, and restart;
- local baseline-channel resolution and immutable start baseline;
- transactional runtime candidate validation/activation with signed production identity and last-known-good preservation;
- proof that no-diff tasks elide publication by default;
- proof that context receipts bind to the exact input/task revision;
- capability doctor separation of declarations, provider identity, and observed enforcement;
- canonical bounded chat-handoff digests and rejection of authority-shaped/local-path fields;
- two-phase handoff replacement preserving the prior verified checkpoint on interruption/corruption;
- fresh-context resume rejecting stale Git/task identity, requiring changed governing docs to be reread, and never repeating/inventing action IDs;
- presence-only tool discovery that cannot become executable authority;
- remote tool-inventory privacy;
- dynamic-operation public schemas that remain non-authority-bearing;
- local manifest rejection of duplicate registration, authority-shaped parameters, path/argv smuggling, and filesystem indirection;
- sandboxed unfamiliar-tool help probing with no control credentials, denied network, hidden configured external read roots, bounded output/time, and fail-closed registration;
- restart-safe persist-before-register reconciliation of generated local manifests;
- persistent agent-key identity validation, public/private projection separation, and locally configured peer-key trust;
- signed lease exact task/revision binding, time/epoch validation, explicit expected-SHA Git CAS, competing-writer reconciliation, and unknown-peer fail-closed behavior;
- unexpired peer/local-session deferral, trusted expiry reclaim, and daemon-lock-qualified same-identity restart reconciliation;
- lease heartbeat/fence/expiry behavior, child-process abort propagation, and prevention of stale sealing/publication effects;
- full-fingerprint task branch namespacing with legacy compatibility when coordination is disabled;
- immutable start-baseline evidence plus independently advancing publication-baseline evidence;
- fast-forward-only baseline reconciliation, exact pre-rebase restoration after conflict, and history-rewrite checkpointing;
- mandatory post-rebase model verification or deterministic-plan replay within bounded turn limits;
- post-verification dirty/local-HEAD/publication-baseline drift invalidation and bounded replay;
- exact locally verified candidate-head binding through lease-aware publication and exact-SHA push payload;
- explicit expected-head task-branch CAS for first creation/rewrite, ambiguous-effect reconciliation, and unexpected-remote refusal;
- pause request/acknowledgement exact lock-token binding, no new cycle while paused, resume, stop precedence, and stale-token rejection;
- below-normal/low child priority application to the actual spawned PID and fail-closed priority-application errors;
- proof that effective task concurrency remains one until an explicit scheduler contract exists.

A passing happy-path test alone is not sufficient for a capability boundary.
