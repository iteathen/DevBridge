# DB-017 — Baseline Drift, Rebase, and Reverification

Status: active

Implementation status: implemented on current main: pre-publication fast-forward baseline reconciliation, bounded recovery evidence, mandatory post-drift reverification, exact locally verified candidate binding, and exact expected-head task-branch publication CAS.

## Goal

A DevBridge task may run long enough for its authorized upstream baseline to advance. A candidate that was verified only against an older baseline must not be published as though it were verified against the current one.

DevBridge therefore reconciles the publication baseline immediately before final completion/publication, without rewriting the evidence describing where the task originally started.

## Two baseline identities

The run has two distinct Git identities:

1. `baseSha` is the immutable **start baseline**. It records the exact commit from which the active run was originally created. DB-008 remains authoritative: later fetches never redefine this historical fact.
2. `publicationBaseSha` is the exact **currently verified publication baseline**. It begins equal to `baseSha` and may advance only through DevBridge's reconciliation procedure below.

Candidate changed-path calculation, diff checks, no-op publication decisions, and final publication evidence use `publicationBaseSha`. Handoffs/context may expose both values, but must not relabel the publication baseline as the original task input.

The baseline branch/ref is also stable for the run. A later change to the repository's default branch does not silently redirect an existing task. A locally authorized named baseline channel must continue to resolve to the same configured branch name.

## Reconciliation point

Before a run is considered complete, DevBridge:

1. seals dirty candidate changes into a DevBridge-owned local commit;
2. refreshes the managed repository through the hardened Git adapter;
3. resolves the same authorized baseline ref used by the run;
4. compares its current head to `publicationBaseSha`;
5. if unchanged, continues normal finalization;
6. if advanced by a strict fast-forward, rebases the sealed candidate onto the new head;
7. invalidates verification evidence collected before that rebase;
8. requires a fresh model verification turn or re-executes the deterministic controller plan and assertions;
9. repeats reconciliation before final completion/publication.

A candidate commit created before step 2 is a local preliminary seal, not proof that stale verification remains valid.

## Upstream movement policy

Automatic reconciliation is permitted only when the newly observed baseline is a descendant of the current `publicationBaseSha`.

- Normal fast-forward branch advancement may be rebased automatically.
- A force-push/history rewrite of the baseline is not silently accepted. DevBridge enters an explicit waiting/checkpoint state with preserved evidence.
- The candidate must itself descend from the persisted publication baseline before DevBridge attempts rebase.
- Rebase runs with the hardened managed Git environment, disabled hooks, no inherited credential helpers, no interactive prompting, and explicit DevBridge commit identity.
- Autostash is disabled; reconciliation starts only from a sealed clean candidate.

## Conflict behavior

A failed automatic rebase must not leave the managed worktree in an unresolved Git-administration state.

DevBridge captures the conflict path set when available, aborts the rebase, verifies that the exact pre-rebase candidate head was restored, and records the failure.

For a model-assisted task, a normal candidate conflict may return to the repair loop so the proposal can be adapted and reverified. A deterministic controller plan cannot invent conflict-resolution logic outside its signed/validated plan and therefore checkpoints instead. Baseline history rewrites checkpoint for all task types.

Checkpointing is not approval to widen authority or force a Git rewrite.

## Reverification semantics

A successful rebase makes prior test/verification evidence stale for publication purposes.

- Model-assisted runs must execute another bounded tool turn against the rebased worktree before they may report complete again.
- Deterministic controller plans re-execute the same validated plan, operations, persistent-file verification, and assertions against the rebased worktree.
- The pre-rebase test list is removed from the current verification projection; the reconciliation history preserves the fact that it was invalidated.
- Repeated baseline movement consumes the existing bounded task/turn window. It must not create an unbounded rebase/reverify loop.

Post-verification local candidate drift follows the same evidence rule. Verification binds to the exact clean candidate identity that was observed when verification completed: its `headSha` and `publicationBaseSha`. Before a persisted `publishing` state may continue, DevBridge re-observes that identity. A dirty worktree, a different local `HEAD`, or a different publication baseline invalidates the prior verification evidence and clears its current test projection.

- Model-assisted local-drift reverification consumes the next normal bounded tool turn.
- Deterministic local-drift reverification consumes the next deterministic verification attempt before replaying the validated plan.
- If the deterministic attempt window is already exhausted, DevBridge checkpoints to `waiting-feedback` and does not invoke the plan executor or publication again until trusted continuation extends the bounded window.

## Exact verified candidate publication identity

Publication is bound to the exact local commit SHA that passed the current verification, not to a symbolic name that can move between verification and the Git effect.

- The final verified snapshot supplies an `expectedHeadSha` to the task-branch publication boundary.
- Immediately before any remote observation or push, the workspace manager validates the current clean local `HEAD` and requires it to equal that exact verified SHA.
- A mismatch fails closed and requires fresh verification before publication.
- The push payload uses the exact verified commit as `<verified-sha>:<task-ref>`. Symbolic `HEAD` is not publication payload identity.
- An already-converged remote branch is idempotent only when the remote exact head equals that same verified local SHA.

The expected verified head is controller-owned recovery/verification evidence. Task text, repository content, tool output, and model output cannot choose or override it.

## Task-branch publication CAS

Baseline rebase rewrites candidate commit IDs, so a recoverable publication path cannot rely on blind force-push.

For a DevBridge-owned task branch:

- DevBridge first observes the exact remote branch head after validating the exact locally verified candidate identity.
- First creation uses an explicitly empty expected value with `--force-with-lease=<ref>:`.
- If the remote already equals the exact verified local head, publication is treated as reconciled/idempotent and that exact observed head may be retained as confirmed remote state.
- A rewritten rebased candidate may replace a remote head only when that exact head was previously confirmed on the remote through DevBridge's own publication/reconciliation path, using `--force-with-lease=<ref>:<expected-sha>`.
- Merely having the same commit locally, including as a pre-rebase candidate head, does not make an unexplained remote branch authoritative or overwriteable.
- Any other remote head fails closed; DevBridge does not overwrite an unexplained branch mutation.
- After push, DevBridge re-observes the branch and records success only if the remote exact head equals the intended verified local head. This allows recovery from an ambiguous transport result without blind retry.

No task/model/controller input may choose the force mode or expected remote SHA.

## Coordination and recovery

DB-016 still fences these effects. Reconciliation, sealing, and publication occur through the lease-aware workspace boundary when coordination is enabled. The lease-aware publication wrapper must preserve the exact `expectedHeadSha` option unchanged while performing the required fresh-lease check before the delegate publication effect.

DB-009 recovery evidence remains authoritative for ambiguous effects. A restart resumes with the immutable `baseSha`, persisted `publicationBaseSha`, exact verified candidate snapshot when present, and a bounded set of exact task-branch heads that DevBridge previously confirmed remotely. It observes before mutating rather than resetting to a remembered branch state.

An interrupted publication does not require trusting an unconfirmed intended head. On recovery, DevBridge first confirms that the managed candidate still equals the persisted verified candidate identity. Then either the remote already equals that exact verified head, which is reconciled idempotently without overwrite, or it still equals a previously confirmed predecessor head, which may be used as the explicit `force-with-lease` expectation. Any local identity drift invalidates verification; any third remote state fails closed.

## Required tests

Tests must cover at least:

- a resumed run retains its immutable original `baseSha` after upstream advances;
- `publicationBaseSha` begins at the original baseline and advances independently;
- non-conflicting fast-forward drift rebases the candidate, preserves only candidate changed paths relative to the new publication baseline, and requires reverification;
- no-project-diff runs also move to the new baseline and require a fresh verification turn when drift occurred;
- rebase conflict aborts and restores the exact pre-rebase candidate head without leaving unmerged state;
- upstream history rewrite is not automatically rebased;
- model verification evidence is cleared after rebase and another model turn is required before completion;
- deterministic controller plans execute again after rebase and remain bounded by the existing turn window;
- resumed publication with a different clean local `HEAD` clears stale test evidence and reverifies before publication;
- resumed publication with a dirty worktree clears stale verification before sealing or publication;
- deterministic local candidate drift consumes the next bounded deterministic attempt, and an exhausted window checkpoints without invoking the plan executor or publication;
- publication rejects a local `HEAD` different from `expectedHeadSha` before any push;
- first task-branch publication pushes `<verified-sha>:<task-ref>` with an explicit empty expected remote value and never relies on symbolic `HEAD` as payload identity;
- rebased branch rewrite uses an exact previously confirmed remote predecessor head while pushing the exact verified local SHA;
- a merely local pre-rebase candidate head does not become task-branch rewrite authority;
- unexpected remote branch mutation is not overwritten;
- ambiguous push that nevertheless reached the exact intended verified head reconciles as success;
- already-converged exact remote state can be recorded as confirmed without another push when it equals the verified local head;
- no-op publication is judged relative to `publicationBaseSha`, not the immutable start baseline;
- the lease-aware publication boundary forwards the exact verified-head option and refuses delegate publication after fencing;
- existing DB-008 Git hardening and DB-016 lease fencing remain intact.
