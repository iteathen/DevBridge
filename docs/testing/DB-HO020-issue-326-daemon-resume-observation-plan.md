# DB-HO020 — issue #326 daemon resume observation

Status: implemented, qualified, and integrated into `cuda-target` with the separately reviewed #328 prerequisite by PR #327 at `2b5a3635a6aa808373b26dd1409e3e7d68fa5279`.

## Assessment

The direct-lock governance test acts as both control client and daemon owner. After starting `resumeDaemon()`, it waits until the pause request is absent and then calls the lock's release action. Release removes the lock and remaining acknowledgement concurrently with `resumeDaemon()`'s observation loop.

`resumeDaemon()` can validly read the still-active exact lock, then observe that release removed both control records, and return `resumed: true, activeLock: true`. That result is a snapshot from its bounded observation; it does not claim the lock remains active after the function returns. The test incorrectly expects concurrent release to deterministically change that earlier snapshot to `false`.

The production protocol already exposes `clearDaemonPauseAcknowledgement()` as the exact token-bound owner action. The real daemon uses it when leaving the paused boundary. No product behavior or external platform behavior is missing, so no external research changes this assessment.

## Plan

1. Import the existing pause-acknowledgement clear action into the governance test.
2. After proving the resume request was consumed, clear the exact acknowledgement with the acquired lock record, simulating the owner action without releasing ownership.
3. Await `resumeDaemon()` while the lock remains held and assert `resumed: true, activeLock: true`.
4. Release the exact lock afterward and separately assert the final inactive/empty status.
5. Preserve the unconditional idempotent release hook from #323 for every failure path.
6. Run the focused file repeatedly, repository preflight, the 21-test VM/LEGO architecture selection, and the full suite before isolated publication.

This slice changes no production daemon, lock, provider, VM, repository-execution, setup, elevation, or runtime authority. It invokes no UAC or physical provider action.

## Implementation

The direct-lock governance test now performs the protocol in deterministic owner order:

1. the control action removes the exact pause request;
2. the test, acting as the token-owning daemon, clears the exact pause acknowledgement;
3. `resumeDaemon()` observes a resumed daemon whose lock is still active;
4. the test releases the lock;
5. a separate observation proves that the lock and all control records are absent.

The unconditional idempotent release hook remains registered before assertions. No production source file changed.

## Local evidence

- focused suite: 4 passed, 0 failed;
- formerly racing test: 50 consecutive additional executions passed;
- repository preflight: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 40`);
- VM/repository-execution LEGO architecture selection: 21 passed, 0 failed;
- full suite: 1,232 total, 1,221 passed, 11 platform skips, 0 failed, with a normal TAP exit in 53.4 seconds.

## Remote evidence

The first PR #327 run (`33127830469`) proved all daemon-governance tests, including this deterministic resume sequence, but later failed at the independent Windows prefix-probe timeout tracked as #328. Stacked PR #329 qualified that separate correction before adding it to the #326 topic branch.

The resulting exact combined head `2f7ef584e223fcf71b79c4fdd4cda1a95eaa5c0e` passed final GitHub Actions run `33128452380`: Ubuntu smoke in 16 seconds, Ubuntu full test in 34 seconds, Windows smoke in 48 seconds, and Windows full test in 2 minutes 9 seconds. PR #327 then squash-merged that green head into `cuda-target`.
