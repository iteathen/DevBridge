# DB-HO044 — issue #360 ephemeral parent cleanup

Status: implemented and hosted-qualified from exact predecessor `64be13ed7d775e94b6ff3be4c1f353e079da6333` on `stage8/362-protected-activity-channel`; physical guest-route qualification remains pending.

## Assessment

The fixed C controller plan currently creates root-level `CMakeLists.txt` and `main.c`. That is safe only for a repository that does not already own either path. It is not a reusable acceptance fixture for arbitrary configured repositories, including C/C++ projects likely to own a root `CMakeLists.txt`.

Moving the two ephemeral files into a deterministic isolated subdirectory exposes an existing generic cleanup defect. `ControllerPlanExecutor` records and removes ephemeral files, but `atomicWrite` recursively creates missing parents without recording them. A nested ephemeral plan therefore leaves empty directories in the host-authoritative worktree after completion. Existing tests hide this because their fake workspace snapshot ignores empty filesystem state.

The source of the defect is the controller-plan materialization owner, not CMake or the C acceptance fixture. A special acceptance operation or a known repository directory would evade the normal pipeline and retain the generic leak.

## Primary-source research

Node's official [`fsPromises.rmdir`](https://nodejs.org/api/fs.html#fspromisesrmdirpath-options) contract removes one identified directory and rejects a non-directory. It is non-recursive by default. This is the required cleanup primitive: a directory containing any unplanned entry must fail closed rather than widening cleanup to recursive removal.

## Reassessment

The executor already persists file cleanup intent before the file effect, removes only exact ledger paths, checks no-follow containment, and guards effects with the active task fence. The smallest complete extension is to apply those same semantics to parent directories that were observed absent before an ephemeral create:

- derive normalized parent paths locally from the already-normalized plan path;
- validate the current ancestor chain with the existing no-follow guard;
- persist exact missing-directory cleanup intents before `mkdir` can run;
- never ledger a pre-existing directory;
- clean files first, then exact owned directories deepest-first;
- remove directories non-recursively, so unexpected content or replacement fails closed;
- re-observe absence and persist each exact terminal state.

No directory supplied by the plan, cleanup root, recursive-delete authority, provider identity, repository identity, VM identity, or platform branch enters the interface. Directory ownership is derived solely from a local before-effect absence observation under the existing serialized worktree transaction.

The C plan can then use a challenge-derived directory such as `route-acceptance-<digest>` and the existing generic configure/build/CTest operations. This avoids collisions without adding a special compiler or acceptance execution path.

## Dependency-ordered plan

1. Add a local missing-parent observer under the existing no-follow root check.
2. Persist deduplicated directory cleanup intents before ephemeral file effects.
3. Extend cleanup to order file entries before deepest directory entries and use exact non-recursive removal.
4. Prove newly created nested parents are absent at completion.
5. Prove pre-existing parents remain.
6. Prove unexpected content/replacement prevents directory cleanup without recursive deletion.
7. Prove interrupted cleanup resumes from the same directory intents.
8. Move the C fixture into a challenge-derived project directory and update its exact plan digest/evidence.
9. Validate a complete normal `devbridge/task-v1` body containing that plan, without a preferred coding tool.
10. Run focused tests, repository preflight, and the complete suite before publication.

No host elevation, provider operation, guest execution, remote task creation, or repository mutation is part of this checkpoint.

## Implementation checkpoint

`ControllerPlanExecutor` now observes the normalized ancestor chain before each ephemeral create and persists exact cleanup intents only for directories that are absent. Cleanup orders files before directories and directories deepest-first. Directory removal uses the exact non-recursive primitive, re-observes absence, and persists the same terminal state as file cleanup. A pre-existing parent is never added to the directory ledger. An owned directory containing unexpected content fails closed, retains that content, and remains recoverable from its persisted cleanup intent.

The C acceptance proposal now uses `route-acceptance-<challenge digest prefix>` as its isolated project directory. The raw proposal remains valid input to the normal task-envelope parser; normalization remains owned by the receiving contract rather than being embedded twice. No repository, provider, environment, VM, operating-system, agent, or coding-model identity entered the module interface.

Evidence on 2026-08-28:

- syntax checks passed for the executor and acceptance modules;
- focused normal, failure, exact-cleanup, recovery, envelope, operation, and scratch tests: 21 passed, 0 failed;
- repository preflight: 102 syntax files, 2 JSON files, and 98 targeted test files passed;
- complete suite: 1,534 passed, 15 platform skips, 0 failed out of 1,549 tests;
- `git diff --check` passed.

No UAC or provider mutation was requested. Physical Linux and Windows evidence remains deliberately unclaimed until the protected profiles can be completed and the exact plan can traverse the ordinary repository-execution route.
