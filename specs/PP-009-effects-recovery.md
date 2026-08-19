# PP-009 — Durable Effects, Recovery, and Reconciliation

Status: active

Implementation status: partially implemented by effect class on current main. Core run/finalization recovery, exact task-branch publication reconciliation, PP-014 handoff projection recovery, PP-015 owned inventory projection, PP-016 lease CAS/release recovery, PP-017 post-drift reverification/publication recovery, and PP-011 runtime activation/rollback are implemented. A single generic effect journal covering every possible future GitHub/remote mutation is still not complete.

## Goal

Survive daemon/process/host failure without losing authoritative run state, silently repeating irreversible effects, or forcing a coding model to reconstruct work that PATCH-POLLER can reconcile itself.

## Governing rule

**Recovery observes and reconciles intended effects before retrying them.**

Exactly-once remote delivery is generally not achievable across a process crash and a remote service. PATCH-POLLER therefore targets durable intent plus idempotent observation/reconciliation rather than pretending an atomic local/remote transaction exists.

## Authoritative state

Restart-critical state is written to the local `StateStore` or another explicit PATCH-POLLER-owned control store before a dependent irreversible/externally visible effect whenever the effect cannot be reconstructed safely from existing state.

At minimum a run records, as applicable:

- run/task/revision identity;
- immutable repository start baseline (`baseSha`);
- current publication baseline (`publicationBaseSha`) when PP-017 reconciliation applies;
- managed worktree/task-branch identity;
- current lifecycle stage;
- bounded turn/verification counters;
- durable context/progress;
- exact candidate/sealed/verified commit identity when available;
- current verification identity/evidence;
- publication state and confirmed remote predecessor heads where applicable;
- feedback/checkpoint/decision state;
- coordination lease/fence identity when enabled;
- known external-effect identifiers/correlation evidence.

Proposal-worker context/result mailboxes are also poller-owned restart evidence. They live under control state outside proposal bytes and carry a control-only manifest binding exact run/turn, filesystem identities, and context digest. Worker-authored project files are never used to reconstruct mailbox authority.

## Effect journal model

The general hardened design uses an operation record with stable operation ID and states equivalent to:

`planned -> attempted -> observed -> reconciled`

Terminal failure/cancellation metadata may be attached without erasing operation history.

An effect record should include:

- operation ID;
- run/task revision;
- effect class;
- exact subject/digest/ref where applicable;
- target service/resource;
- authorization/checkpoint/lease subject where applicable;
- attempt timestamps/count;
- observed remote identity/result;
- reconciliation outcome;
- policy/protocol version.

Examples include task-branch push, owned status/inventory/handoff comment creation/update, label update, checkpoint publication, PR creation, merge/promotion, lease transition, and release/deployment effects.

Current implementations may use effect-specific durable state instead of one universal record type, but they MUST preserve the same governing invariants. New remote effect classes should not invent a less durable retry model merely because the generic abstraction is incomplete.

## Idempotency and observation

Every effect must have an effect-specific reconciliation strategy.

Examples in current behavior:

- **task-branch publication:** PP-017 validates exact locally verified head, observes exact remote task-ref head, uses explicit expected-value CAS, and re-observes after ambiguous push;
- **coordination lease transitions:** PP-016 uses signed state plus exact predecessor Git-ref CAS and re-observation instead of blind force;
- **runtime activation:** PP-011 persists accepted candidate/previous runtime evidence, rechecks exact artifact identity at activation, and retains last-known-good for rollback;
- **chat handoff projection:** PP-014 uses durable projection state/correlation so crash recovery can avoid uncontrolled duplicate projection;
- **tool inventory projection:** PP-015 owns its exact durable comment ID and does not adopt marker-looking user comments;
- **known comment update:** an already persisted comment ID can be updated idempotently by ID.

A generic `retry()` loop is not a reconciliation strategy.

### Remaining generic creation gap

Not every remote creation path has been converted to a universal reconciled-effect primitive. In particular, the ordinary run status reporter persists a newly created comment ID **after** GitHub returns success. A crash after GitHub accepts the initial POST but before local persistence can therefore still require future correlation/reconciliation logic and can risk duplicate status creation on recovery.

This gap must remain explicit. Do not claim generic exactly-once GitHub mutation semantics from the fact that critical publication/lease/update/projection paths have their own stronger reconciliation.

## Run recovery

On startup/daemon continuation the coordinator examines durable non-terminal runs before claiming or advancing work as appropriate.

Recovery behavior is stage-aware:

- `preparing`/`running`: reconstruct managed workspace/context and continue within bounded policy;
- `waiting-feedback`/`waiting-decision`: poll/observe only the bound trusted feedback/decision channels while allowing PP-007 safe-frontier work where applicable;
- `verifying`: revalidate/seal/reconcile candidate state rather than invoking another model merely to repeat finalization;
- `publishing`: re-observe exact local candidate identity, verification/gate/lease validity, publication baseline, and remote task-ref state before any further publication effect;
- uncertain interrupted proposal-worker invocation: preserve worktree and inspect resulting state conservatively. If exact control-owned run/turn mailbox exists, `ProcessRunner.recoverResult()` may reopen it only after revalidating manifest/file identities and unchanged context; otherwise the bounded fresh-turn recovery path may be used where policy allows;
- interrupted deterministic plan: reuse durable completed evidence when exact identities still match, otherwise replay only within the bounded deterministic verification/recovery rules;
- baseline/local-candidate drift during persisted verification/publication: PP-017 invalidates stale verification and consumes the appropriate bounded reverification window before later effects.

A recovered worker result is not authoritative run state. It is proposal evidence subject to the same result protocol, provenance, candidate validation, lease, hard-gate, and publication rules as a result returned before interruption.

An empty, malformed, missing, or identity-invalid mailbox never expands authority; policy/identity violations fail closed, while ordinary missing proposal output may lead to an existing bounded fresh-turn recovery path.

## Proposal-content rejection versus infrastructure failure

A verification attempt that proves the **proposal itself** invalid is different from a verification infrastructure/control-plane failure.

Candidate-content rejection (for example whitespace/check failures, unresolved proposal state, final-byte mismatch, or another repairable candidate invariant) must:

1. preserve useful working-tree proposal bytes unless policy requires disposal;
2. restore PATCH-POLLER-owned Git/index state so a rejected staging attempt does not become persistent authority residue;
3. persist exact validator evidence as run context/blocker;
4. return to a bounded repair/reverification path when local policy and remaining budget allow;
5. never grant proposal engine Git-administrative/capability authority merely because sealing failed.

By contrast, an infrastructure/control-plane failure during verification/publication retains durable stage/intent and is retried/reconciled without rerunning proposal inference unless later evidence proves project content itself requires repair.

## Baseline and verification identity

The original `baseSha` is immutable historical evidence across recovery.

PP-017 adds separate `publicationBaseSha` and exact verified candidate identity. Recovery MUST NOT treat previously persisted tests as current when:

- publication baseline changed;
- managed worktree became dirty;
- local `HEAD` changed;
- candidate was rebased/recreated;
- exact hard-gate subject changed/expired;
- PP-016 lease/fence is no longer valid.

Stale evidence is invalidated and bounded reverification/redecision occurs under the owning spec before later effects.

## Failure taxonomy

Recovery/retry policy distinguishes at least:

1. `POLICY_SECURITY` — never automatically bypass or retry with more authority;
2. `INFRASTRUCTURE` — controlled local recovery may be attempted;
3. `TRANSIENT` — bounded retry only where operation is idempotent/reconcilable;
4. `CODE` — return evidence to proposal engine/controller when allowed;
5. `PROTOCOL` — malformed/contradictory agent/control-channel data.

Candidate validation rejection is a `CODE`/proposal-quality outcome unless evidence indicates a security/policy violation that local policy says must not be delegated back for repair.

Unknown failures default to conservative handling, not privilege expansion.

## Locks, leases, and ownership

The local daemon singleton lock is lifecycle ownership authority for one PATCH-POLLER state root. Lock files are not blindly deleted because they appear old; uncertain ownership requires explicit observation/recovery.

PP-016 now implements distributed task coordination for multiple authorized installations:

- signed task leases live behind PATCH-POLLER-owned Git refs;
- transitions use explicit exact expected-value CAS;
- heartbeat/TTL/skew govern reclaim;
- same persistent identity does not permit immediate session takeover unless current daemon path already proved local singleton ownership;
- definite CAS loss/expiry fences stale work/effects;
- terminal lease release is signed CAS state rather than blind ref deletion.

A lease is coordination authority only. It does not replace durable run/effect state or grant task/capability/decision/publication authority.

## PP-018 pause and ownership recovery

Cooperative pause is not a new run/effect journal.

Pause request/acknowledgement binds to exact current daemon lock token. A pause requested during active work is acknowledged only after the current bounded cycle reaches its existing safe boundary; lease heartbeat/fencing and current effect recovery remain valid during that cycle.

A fully paused daemon preserves managed worktrees, run state, mailbox/checkpoint/lease evidence and performs no normal new task admission. Stop has precedence and releases only matching owner control state.

## Worktree and control-state retention

Failed, waiting, uncertain, checkpointed, or decision-pending worktrees are evidence and may be needed for resumption. Cleanup must be ownership/containment based and delete only paths PATCH-POLLER can prove it owns.

Successful terminal worktrees may be retained for a bounded period or disposed under configured retention policy after required evidence has been sealed.

Control-owned worker exchange directories, PP-016 identity/lease evidence, PP-014 handoffs, runtime activation state, and daemon control records are not proposal-tree cleanup targets. Their retention/reconciliation follows their owning specs/control-state policy.

## Remote status is not run authority

A failed GitHub status update must not retroactively make successful local validation fail or erase the run. Conversely a `COMPLETED` comment does not create completion authority if local state/candidate validation did not reach completion.

PATCH-POLLER state is authoritative; GitHub status is a bounded coordination/observability projection.

Marker-looking remote text is not automatically adopted as controller-owned state. Any projection/reconciliation scheme that adopts existing remote objects must prove exact ownership/correlation under its owning protocol.

## Required tests

Tests must cover at least:

- restart during final verification does not rerun model/deterministic inference unnecessarily when exact durable evidence remains valid;
- candidate-content validation rejection restores control-plane Git/index state, preserves repairable working-tree bytes, and returns to bounded repair rather than looping in `verifying`;
- verification/publication infrastructure failure does not rerun proposal inference unnecessarily;
- restart during publication reconciles exact verified candidate SHA and expected remote state;
- duplicate task revision does not execute again;
- newer revision of one issue is deferred while older revision remains active;
- upstream movement never rewrites immutable original `baseSha`;
- PP-017 baseline/candidate drift invalidates stale verification during recovery;
- feedback/decision replay/mismatch cannot resume/approve another run;
- interrupted worker result recovery is bound to exact control-owned run/turn mailbox and does not trust project paths;
- mailbox identity/substitution failure cannot become privileged recovery read;
- PP-016 lease CAS/expiry/fence state prevents stale worker/sealing/publication effects;
- PP-018 pause preserves evidence and does not create a lease/effect bypass;
- task-branch ambiguous publication reconciles by exact remote observation rather than blind retry;
- runtime activation failure retains/restores exact last-known-good evidence;
- chat/inventory projection crash windows follow their owned reconciliation rules;
- ordinary status-comment creation crash window remains covered by a future generic/correlation test once that gap is implemented;
- retries stop at policy/rate/attempt/time bounds.

## Current boundary

Current main has strong, effect-specific durability for the critical local run, candidate publication, runtime activation, multi-agent lease, chat-handoff projection, tool-inventory projection, and baseline-drift recovery paths.

The remaining PP-009 work is to make that discipline universal for new/remaining remote effects rather than assuming each future GitHub mutation is safe to retry. In particular, generic newly-created remote-object correlation/effect journaling is not yet complete.

Do not use the phrase "exactly once" for remote effects unless the specific effect protocol and failure window actually justify it.
