# PP-009 — Durable Effects, Recovery, and Reconciliation

Status: active

Implementation status: partially implemented in v0.1.

## Goal

Survive daemon/process/host failure without losing authoritative run state, silently repeating irreversible effects, or forcing a coding model to reconstruct work that PATCH-POLLER can reconcile itself.

## Governing rule

**Recovery observes and reconciles intended effects before retrying them.**

Exactly-once remote delivery is generally not achievable across a process crash and a remote service. PATCH-POLLER therefore targets durable intent plus idempotent observation/reconciliation rather than pretending an atomic local/remote transaction exists.

## Authoritative state

Restart-critical state is written to the local `StateStore` before a dependent irreversible or externally visible effect whenever the effect cannot be reconstructed safely from existing state.

At minimum a run records:

- run/task/revision identity;
- immutable repository baseline;
- managed worktree and task branch identity;
- current lifecycle stage;
- turn counter;
- durable context/progress;
- final sealed candidate identity when available;
- publication state;
- feedback/checkpoint state;
- known external-effect identifiers.

## Effect journal model

The hardened design uses an operation record with a stable operation ID and states equivalent to:

`planned -> attempted -> observed -> reconciled`

Terminal failure/cancellation metadata may be attached without erasing the operation history.

An effect record should include:

- operation ID;
- run/task revision;
- effect class;
- exact subject/digest/ref where applicable;
- target service/resource;
- authorization/checkpoint subject where applicable;
- attempt timestamps/count;
- observed remote identity/result;
- reconciliation outcome;
- policy version.

Examples include branch push, status-comment creation/update, label update, checkpoint publication, PR creation, merge/promotion, and release/deployment effects.

## Idempotency

An operation must have an effect-specific reconciliation strategy.

Examples:

- pushing the same sealed SHA to the same dedicated task ref can be observed/repeated safely when policy permits;
- updating a known status comment can be retried by comment ID;
- creating a comment or PR needs a durable correlation marker/query so a crash after remote success but before local persistence does not blindly create duplicates;
- promotion/merge/release operations require exact artifact binding and stronger observation before retry.

A generic `retry()` loop is not a reconciliation strategy.

## Run recovery

On startup the coordinator examines durable non-terminal runs before claiming new work.

Recovery behavior is stage-aware:

- `preparing`/`running`: reconstruct workspace and continue from durable context;
- `waiting-feedback`/future decision states: poll only the bound feedback/decision channel;
- `verifying`: seal/revalidate the candidate rather than invoking another model merely to repeat finalization;
- `publishing`: reconcile/push the already sealed candidate rather than requesting another model turn;
- uncertain interrupted tool invocation: preserve the worktree, inspect resulting state, and continue conservatively; full invocation-level reconciliation is a future hardening area.

A verification attempt that proves the **proposal itself** invalid is different from a verification infrastructure failure. Candidate-content rejection (for example whitespace/check failures, unresolved proposal state, or another repairable candidate invariant) must:

1. leave the working-tree proposal intact;
2. restore PATCH-POLLER-owned Git index state so a rejected staging attempt does not become persistent residue;
3. persist the exact validator evidence as run context/blocker;
4. move the run back to `running` for another bounded proposal-engine repair turn when turn budget remains;
5. never grant the proposal engine Git-administrative authority merely because sealing failed.

By contrast, an infrastructure/control-plane failure during verification or publication must keep the durable `verifying`/`publishing` stage and be retried/reconciled without rerunning the proposal engine unless later evidence proves the project content itself requires repair.

The original baseline SHA must remain unchanged across recovery.

## Failure taxonomy

Recovery and retry policy distinguishes at least:

1. `POLICY_SECURITY` — never automatically bypass or retry with more authority;
2. `INFRASTRUCTURE` — controlled local recovery may be attempted;
3. `TRANSIENT` — bounded retry only where the operation is idempotent/reconcilable;
4. `CODE` — return evidence to the proposal engine/coordinator;
5. `PROTOCOL` — malformed/contradictory agent or control-channel data.

Candidate validation rejection is a `CODE`/proposal-quality outcome unless the evidence indicates a security/policy violation that local policy says must not be delegated back for repair.

Unknown failures default to conservative handling, not privilege expansion.

## Locks and ownership

v0.1 uses a single local daemon ownership lock. A lock file is not blindly deleted because it appears old; uncertain ownership requires operator/recovery logic.

Future concurrent workers require explicit per-repository leases before Git operations are parallelized. Distributed leases remain out of scope until a real workload requires them.

## Worktree retention

Failed, waiting, uncertain, or checkpointed worktrees are evidence and may be needed for resumption. Cleanup must be lease/ownership based and only delete paths PATCH-POLLER can prove it owns.

Successful terminal worktrees may be retained for a bounded period or disposed under configured retention policy after required evidence has been sealed.

## Remote status is not run authority

A failed GitHub status update must not retroactively make successful local validation fail or erase the run. Conversely a `COMPLETED` comment does not create completion authority if local state/candidate validation did not reach completion.

PATCH-POLLER state is authoritative; GitHub status is a durable coordination projection of it.

## Required tests

Tests must cover at least:

- restart during final verification does not rerun the model unnecessarily;
- a candidate-content validation rejection restores the control-plane-owned index, preserves working-tree bytes, and returns to a bounded repair turn rather than looping in `verifying`;
- verification/publication infrastructure failure does not rerun the model unnecessarily;
- restart during publication reconciles the same sealed SHA;
- duplicate task revision does not execute again;
- a newer revision of one issue is deferred while an older revision remains active;
- upstream movement does not redefine an active run baseline;
- feedback replay/mismatch cannot resume another run;
- crash windows around remote comment/PR creation are reconciled without unbounded duplication once those operations are implemented;
- retries stop at policy/rate/attempt bounds.

## v0.1 boundary

v0.1 implements atomic JSON run state, immutable baseline persistence, duplicate-revision suppression, active-revision deferral, resumable feedback, transactional candidate sealing, repair-turn recovery for rejected candidate content, and stage-aware finalization/publication recovery. A repeated task-branch push uses the same sealed local SHA.

v0.1 does **not** yet implement the complete generic effect journal. In particular, a crash after GitHub accepts a newly created status comment but before its ID is persisted can still require future reconciliation logic, and an interrupted model invocation may be followed by another bounded model turn after workspace inspection. Those limitations are explicit rather than hidden.
