# DB-HO063: nested Git workspace LEGO internals

Date: 2026-08-28

Issue: #249

Status: implementation complete locally; hosted qualification pending. This document authorizes no setup, elevation, service, provider, image, VM, guest, repository-execution, or publication effect.

## Assessment

`GitWorkspaceManager` is the correct single caller-facing authority for managed repository admission, exact run worktrees, candidate Git state, publication-baseline reconciliation, and task-branch publication. Its current 614-line implementation nevertheless combines seven independently changing mechanics and recovery obligations:

- managed repository creation, origin verification, fetch, default-ref admission, and runtime exclusion;
- locally authorized semantic-baseline resolution and persisted publication-ref validation;
- exact run worktree creation/resume and branch/path identity;
- workspace observation plus project-change validation;
- proposal index restoration, staging validation, and candidate commit sealing;
- clean-candidate baseline ancestry/rebase/abort/restore reconciliation; and
- exact remote task-ref observation, known-predecessor retention, force-with-lease CAS, and ambiguous-push reconciliation.

The parent must retain the public constructor and methods (`branchName`, `worktreePath`, `ensureRepository`, `prepareRun`, `snapshot`, `validate`, `reconcilePublicationBaseline`, `sealCandidate`, and `publishTaskBranch`), the sole authoritative Git/workspace identity, local policy/topology composition, branch namespace, baseline-channel configuration, token and remote URL authority, fetch timeout, and mutation of the caller-owned durable workspace projection. Higher layers must never receive a raw Git runner or extracted child.

DB-003, DB-008, DB-009, DB-017, and DB-020 require authoritative Git and publication to stay host/control-plane owned; guest Git remains untrusted; task/repository/controller content cannot choose host paths, raw refs, remotes, expected predecessor state, credentials, or force policy; ambiguous publication must observe exact remote state before any repeat; original `baseSha` remains immutable; only a same-ref fast-forward can advance `publicationBaseSha`; rebase failure must abort and prove exact pre-rebase restoration; and publication must bind the exact verified local SHA to an explicit expected remote SHA or absence.

Existing focused tests already divide along these boundaries: origin admission, semantic baselines, managed worktree resume, snapshot/validation, sealing transaction recovery, baseline fast-forward/rewrite/conflict recovery, and publication CAS/ambiguous convergence. Coordinator and end-to-end tests prove that callers use only the parent surface.

## Primary-source research

- Git documents that `worktree add -b <branch> <path> <commit-ish>` creates and checks out a new branch at the exact supplied commit, while adding an existing branch is refused if another worktree already has it checked out. The lifecycle child must preserve the current explicit branch-exists observation and must not introduce `-B` or `--force`, which would weaken those safeguards: <https://git-scm.com/docs/git-worktree>.
- Git documents that `git diff A...B` compares `B` with the merge base of `A` and `B`. The observation child must preserve the current three-dot committed-change calculation relative to `publicationBaseSha`, rather than casually replacing it with a two-endpoint diff: <https://git-scm.com/docs/git-diff>.
- Git documents that `--no-autostash` disables implicit stash creation and that `rebase --abort` returns to the original branch state. The reconciliation child must keep clean-candidate admission, explicit `--no-autostash`, abort-on-failure, and exact restored-HEAD verification: <https://git-scm.com/docs/git-rebase>.
- Git documents that `--force-with-lease=<ref>:<expect>` updates only when the remote ref equals the explicit expected value, and an empty `<expect>` requires the ref not to exist. The publication child must preserve the fully explicit form, exact SHA refspec, and post-attempt observation; shorthand lease forms or blind force are not equivalent: <https://git-scm.com/docs/git-push>.

## Reassessment

A single extracted "Git helper" would only move the oversized reasoning surface. Separating every command would distribute authority and produce geometry without ownership. The smallest complete decomposition is seven closed mechanics behind the unchanged parent:

1. A **repository-admission owner** receives bounded path, remote, credential, and command ports. It owns create-if-authorized, exact origin comparison, runtime exclusion, fetch, default-ref recovery, and admission evidence. It cannot choose a repository, remote, token, or host root.
2. A **baseline owner** receives locally configured channel mappings plus an exact command port. It resolves an authorized start baseline or revalidates the persisted publication ref. It cannot mutate a worktree or accept a raw remote-selected channel.
3. A **worktree-lifecycle owner** receives already-derived path/branch/baseline identities. It owns contained parent creation, exact existing worktree/branch identity, and non-forcing add/resume behavior. It cannot derive branch names, choose roots, or reset existing state.
4. A **workspace-observation owner** receives one admitted location and baseline identity. It owns exact snapshot assembly, dirty/unmerged/reserved-path checks, and the three diff-check classes. It cannot stage, commit, reset, rebase, fetch, or publish.
5. A **candidate-sealing owner** receives observation/validation ports and exact commit metadata from the parent. It owns rejected-index restoration, bounded staging, reserved-path recheck, diff check, commit, and rollback-on-uncommitted-failure. It cannot reconcile or publish.
6. A **baseline-reconciliation owner** receives exact before/current identities and a validation port. It owns ancestry checks, no-op/reset/rebase selection, conflict enumeration, abort, restored-head proof, and final clean observation. It cannot fetch, resolve another channel, seal, or publish.
7. A **publication-transaction owner** receives an exact verified local snapshot, locally derived ref, credential/auth context, and bounded known predecessor set. It owns exact remote observation, explicit lease expectation, SHA-to-ref push, post-attempt convergence, and bounded confirmed-head projection. It cannot select a branch namespace, infer verification, or publish any other ref.

Only the parent composes the children, supplies current policy and context-specific error factories/messages, and sequences public multi-mechanic operations: `prepareRun` composes admission, baseline, and lifecycle; `sealCandidate` composes sealing followed by reconciliation; reconciliation composes fresh admission/current-baseline resolution with the rebase owner. Children import no sibling or local implementation and expose no child publicly.

## Scoped plan

1. Freeze every public method, returned workspace/snapshot/publication shape, command argv/order/options, exact durable identity, error class/details, diagnostic, and mutation point.
2. Extract admission, baseline, lifecycle, observation, sealing, reconciliation, and publication as complete local owners under `src/git/workspace-manager/`.
3. Keep repository/path/remote/token/channel/branch derivation and all child topology in `GitWorkspaceManager`; inject neutral command, containment, observation, and error ports into children.
4. Preserve explicit non-forcing worktree behavior, original/publication baseline separation, proposal-index restoration, clean-candidate rebase rules, exact abort restoration, exact verified-head admission, known-predecessor bound, explicit force-with-lease expectation, and post-push observation.
5. Delete moved code from the parent. Add direct child contract tests covering normal, failure, recovery, and authority boundaries, plus a source gate proving children import no local implementation/sibling and higher layers still import only the parent.
6. Retain and run all origin, baseline, worktree, snapshot, seal, rebase, publication-CAS, coordinator, and end-to-end parent proofs. Add repeated conflict/seal/publication recovery stress, repository preflight, complete suite, `git diff --check`, and exact hosted Windows/Ubuntu CI.

## Acceptance boundary

This is behavior-preserving structural work. It does not clone/fetch/push a real remote during implementation qualification, publish a task branch, execute repository code, activate a provider, or touch physical VM state. During the operator's three-day no-UAC interval it performs no protected operation and requests no elevation.

## Implementation checkpoint

`GitWorkspaceManager` remains the only caller-facing and authoritative Git/workspace surface. Its admission, baseline, worktree lifecycle, observation/validation, candidate sealing, baseline reconciliation, and publication transaction mechanics now live in seven closed nested owners. Only the parent composes those owners, chooses repository/path/remote/token/channel/branch policy, creates product-specific errors and commit identity, sequences multi-mechanic public operations, and exposes the stable methods and return shapes. No production caller imports a child.

Moved code was deleted rather than retained through wrappers. Each child imports only Node built-ins, knows no sibling or parent implementation, and contains no provider, platform, remote-service, controller/model, product, child-process, or VM topology. Exact command argv/order/options and existing externally visible diagnostics/error classes remain at the parent edge. The implementation retains non-forcing worktree creation, three-dot committed-change observation, rejected-index restoration, clean-candidate `--no-autostash` rebase, abort plus exact HEAD restoration, immutable start-baseline evidence, mutable publication-baseline evidence, exact verified local head admission, bounded confirmed remote predecessors, explicit force-with-lease expectation, and post-attempt observation.

Local qualification on 2026-08-28:

- direct child plus retained admission/baseline/worktree/seal/rebase/publication/coordinator/end-to-end proofs: 29/29 passed;
- wider baseline reverification, candidate repair, hard-gate, lease fence, transient recovery, coordinator, and publication set: 70/70 passed;
- three repeated real-Git seal/rebase/publication recovery runs: 15/15 passed in each iteration;
- repository preflight: 153 syntax files, 2 JSON files, and 136 targeted test files passed in 37.21 seconds locally;
- complete suite: 1,709 total, 1,694 passed, 15 expected platform skips, zero failures;
- topology scan and `git diff --check`: passed.

No real remote mutation, UAC request, protected operation, setup, service/provider/image/environment/VM/guest action, or repository-code execution occurred. Commit and push the exact checkpoint, then require hosted Windows/Ubuntu qualification before closing #249.

Hosted attempt 1, run `33216113376` on commit `1d452f50c204fb2bc0a51fa742cfea1f2614a848`, passed Windows serialized complete-suite/doctor and both Ubuntu jobs, but Windows smoke timed out at its fixed one-minute job boundary. The failure was introduced by registering five expensive real-Git parent suites in the cheap preflight list; those same suites passed in the complete Windows job. Reassessment keeps the fast direct nested contract in preflight and the real-Git parent/recovery suites in full qualification. The product timeout is unchanged, and coverage is not removed from the complete suite.
