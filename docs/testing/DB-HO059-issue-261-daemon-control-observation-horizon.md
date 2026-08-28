# DB-HO059: daemon control-record observation horizon

Date: 2026-08-28

Issue: #261

Status: correction planned; no setup, elevation, service, provider, image, environment, VM, guest, or repository execution is authorized by this document.

## Assessment

The daemon control reader introduced under #366 retries an immutable record read only after `EPERM`, using fixed 5, 10, 20, 40, and 80 millisecond delays. Hosted Windows run `33206528459` exhausted that complete 155-millisecond horizon while the live daemon read its exact token-bound pause request. The full test then reported an unhandled daemon rejection from `readBoundedText -> readControlRecord -> hasDaemonPauseRequest`.

This is a second post-#366 observation of the same Windows access-denial class, now after the original bounded repair. The record was not absent, malformed, stale, or rebound: the requesting control operation had just published it, no resume operation was running, and the exact preceding implementation head passed unchanged behavior. Treating the denial as absence would let a daemon cross a requested pause boundary; propagating it after an empirically inadequate observation horizon terminates the daemon and violates the cooperative-control reliability goal.

## Primary-source research

- Microsoft documents that a Windows file open fails when its requested access conflicts with an existing handle's sharing mode, and that the restriction remains until the handle closes: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea>.
- Node documents that promise-based filesystem operations use the underlying thread pool and are not synchronized with one another: <https://nodejs.org/api/fs.html#promises-api>.
- Node's own bounded filesystem recovery options classify `EPERM` among transient codes and use increasing wait intervals for retryable operations. Those options do not apply to `readFile`, so DevBridge must retain its own closed read policy rather than assuming Node retries it: <https://nodejs.org/api/fs.html#fspromisesrmpath-options>.

The new evidence remains exactly `EPERM`. It does not justify adding `EACCES`, `EBUSY`, `ENOENT`, parsing failures, schema failures, token mismatch, or PID mismatch to the transient class.

## Reassessment

The publication protocol is already close-write-sync-rename, and the failure occurs after publication. Replacing token-bound files, weakening validation, treating uncertainty as absence, or adding caller-selected retry controls would change the wrong ownership boundary.

The smallest complete correction is to extend the same topology-neutral primitive's fixed exponential observation horizon by 160, 320, and 640 milliseconds. That produces nine total observations and at most 1,275 milliseconds of waiting. Success remains immediate. A permanent denial still returns the exact final error. The bound remains well inside the daemon governance test's 10-second deadline and the ordinary control command's 15-second deadline, while addressing evidence that 155 milliseconds is insufficient on hosted Windows.

## Plan

1. Extend only the fixed `EPERM` delay sequence in `bounded-text-read.js`; expose no new option or caller policy.
2. Update deterministic recovery and exact-exhaustion tests for the complete closed schedule and final error identity.
3. Preserve immediate propagation of every other code and all daemon-owned absence/schema/token/PID rules.
4. Run focused text-read/daemon/LEGO tests repeatedly, repository preflight, the complete suite, and exact hosted Windows/Ubuntu CI.
5. Require multiple exact hosted runs before closing #261 because the defect is intermittent.

## Acceptance boundary

This change improves observation of already-published local control records. It does not grant a retry to any effect, mutate a publication schema, weaken ownership, or authorize elevated/protected work.

## Implementation checkpoint

`bounded-text-read.js` now contains the exact closed schedule `[5, 10, 20, 40, 80, 160, 320, 640]`. No caller option, platform branch, topology name, daemon identity, or additional error code was introduced. The reader still returns successful text unchanged, propagates `ENOENT`/`EACCES`/`EBUSY` immediately, leaves parsing and record authority to the caller, and rethrows the exact ninth `EPERM` after exhaustion.

Local evidence:

- focused text-read/LEGO/daemon-lock/daemon-governance/pause-admission suite: 19 passed, 0 failed;
- ten additional consecutive daemon-governance runs: passed;
- repository preflight: 128 syntax files, 2 JSON files, and 126 targeted test files passed;
- complete repository suite: 1,678 total, 1,663 passed, 15 expected platform skips, 0 failed;
- `git diff --check`: passed.

Multiple hosted Windows/Ubuntu runs on the exact implementation commit remain required before #261 closes because the observed access denial is intermittent. No UAC or protected operation occurred.
