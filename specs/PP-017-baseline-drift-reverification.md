# PP-017 — Baseline Drift, Rebase, and Reverification

Status: active

Implementation status: v0.1 implements pre-publication fast-forward baseline reconciliation, bounded recovery evidence, mandatory post-rebase reverification, and exact expected-head task-branch publication CAS.

## Goal

A PATCH-POLLER task may run long enough for its authorized upstream baseline to advance. A candidate that was verified only against an older baseline must not be published as though it were verified against the current one.

PATCH-POLLER therefore reconciles the publication baseline immediately before final completion/publication, without rewriting the evidence describing where the task originally started.

## Two baseline identities

The run has two distinct Git identities:

1. `baseSha` is the immutable **start baseline**. It records the exact commit from which the active run was originally created. PP-008 remains authoritative: later fetches never redefine this historical fact.
2. `publicationBaseSha` is the exact **currently verified publication baseline**. It begins equal to `baseSha` and may advance only through PATCH-POLLER's reconciliation procedure below.

Candidate changed-path calculation, diff checks, no-op publication decisions, and final publication evidence use `publicationBaseSha`. Handoffs/context may expose both values, but must not relabel the publication baseline as the original task input.

The baseline branch/ref is also stable for the run. A later change to the repository's default branch does not silently redirect an existing task. A locally authorized named baseline channel must continue to resolve to the same configured branch name.

## Reconciliation point

Before a run is considered complete, PATCH-POLLER:

1. seals dirty candidate changes into a PATCH-POLLER-owned local commit;
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
- A force-push/history rewrite of the baseline is not silently accepted. PATCH-POLLER enters an explicit waiting/checkpoint state with preserved evidence.
- The candidate must itself descend from the persisted publication baseline before PATCH-POLLER attempts rebase.
- Rebase runs with the hardened managed Git environment, disabled hooks, no inherited credential helpers, no interactive prompting, and explicit PATCH-POLLER commit identity.
- Autostash is disabled; reconciliation starts only from a sealed clean candidate.

## Conflict behavior

A failed automatic rebase must not leave the managed worktree in an unresolved Git-administration state.

PATCH-POLLER captures the conflict path set when available, aborts the rebase, verifies that the exact pre-rebase candidate head was restored, and records the failure.

For a model-assisted task, a normal candidate conflict may return to the repair loop so the proposal can be adapted and reverified. A deterministic controller plan cannot invent conflict-resolution logic outside its signed/validated plan and therefore checkpoints instead. Baseline history rewrites checkpoint for all task types.

Checkpointing is not approval to widen authority or force a Git rewrite.

## Reverification semantics

A successful rebase makes prior test/verification evidence stale for publication purposes.

- Model-assisted runs must execute another bounded tool turn against the rebased worktree before they may report complete again.
- Deterministic controller plans re-execute the same validated plan, operations, persistent-file verification, and assertions against the rebased worktree.
- The pre-rebase test list is removed from the current verification projection; the reconciliation history preserves the fact that it was invalidated.
- Repeated baseline movement consumes the existing bounded task/turn window. It must not create an unbounded rebase/reverify loop.

## Task-branch publication CAS

Baseline rebase rewrites candidate commit IDs, so a recoverable publication path cannot rely on blind force-push.

For a PATCH-POLLER-owned task branch:

- PATCH-POLLER first observes the exact remote branch head.
- First creation uses an explicitly empty expected value with `--force-with-lease=<ref>:`.
- If the remote already equals the local exact head, publication is treated as reconciled/idempotent.
- A rewritten rebased candidate may replace a remote head only when that remote head is one of the exact locally recorded pre-rebase candidate heads for this run, using `--force-with-lease=<ref>:<expected-sha>`.
- Any other remote head fails closed; PATCH-POLLER does not overwrite an unexplained branch mutation.
- After push, PATCH-POLLER re-observes the branch and records success only if the remote exact head equals the intended local head. This allows recovery from an ambiguous transport result without blind retry.

No task/model/controller input may choose the force mode or expected remote SHA.

## Coordination and recovery

PP-016 still fences these effects. Reconciliation, sealing, and publication occur through the lease-aware workspace boundary when coordination is enabled.

PP-009 recovery evidence remains authoritative for ambiguous effects. A restart resumes with the immutable `baseSha`, persisted `publicationBaseSha`, and bounded known pre-rebase task heads; it observes before mutating rather than resetting to a remembered branch state.

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
- first task-branch publication uses an explicit empty expected remote value;
- rebased branch rewrite uses the exact observed/recorded predecessor head;
- unexpected remote branch mutation is not overwritten;
- ambiguous push that nevertheless reached the exact intended head reconciles as success;
- no-op publication is judged relative to `publicationBaseSha`, not the immutable start baseline;
- existing PP-008 Git hardening and PP-016 lease fencing remain intact.
