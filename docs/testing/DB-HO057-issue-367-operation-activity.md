# DB-HO057: operation activity identity and safe cancellation

Date: 2026-08-28

Issue: #367

Status: implemented and locally qualified; hosted qualification pending. No provider, VM, guest transport, setup, service, or elevation effect is authorized by this document.

## Assessment

The guest bridge persists `monitorPid` and `childPid` as recovery identities. Observation calls `process.kill(pid, 0)` and reports `running` when any process currently owns that number. A separate bridge invocation handling cancellation reads `childPid` from disk and sends a tree-termination request to that number.

Those are boundary defects, not merely flaky tests:

- a process identifier is a reusable locator, not a durable execution identity;
- an unrelated later process can make a lost operation look live;
- cancellation can terminate an unrelated later process;
- a request-owned monitor claim is deleted and reacquired while `planned`, so claim ownership still depends on interpreting transient process state;
- filenames, provider names, process names, and test serialization cannot repair identity.

The owning boundary is guest-local exact-effect recovery. It must remain independent of provider, repository, controller, transport, and platform identities.

## Primary-source research

- Microsoft documents that `Win32_Process.ProcessId` values are reused and explicitly warns that PID-only monitoring can mistake the reused process for the original: <https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process>.
- Microsoft documents that a process identifier remains valid until all handles to the process are closed and may then be reused: <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information>.
- Microsoft exposes creation time through `GetProcessTimes`, confirming that a second discriminator would be required if Windows process identity were made the contract: <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes>.
- Node.js 22.16 documents signal `0` only as an existence test for the current PID: <https://nodejs.org/download/release/v22.16.0/docs/api/process.html#processkillpid-signal>.
- Node.js 22.16 warns that sending a signal to an exited child's reassigned PID may affect an unrelated process and that killing a child does not reliably terminate descendants: <https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#subprocesskillsignal>.
- Node.js maps exclusive create (`wx`) to `O_EXCL`, which fails when the path already exists: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#file-system-flags>.

## Reassessment

Adding platform-specific process creation-time probes would make provider-independent guest recovery depend on foreign operating-system object shapes while still leaving cancellation and descendant ownership split across invocations. The smaller complete design removes durable process identifiers from the protocol.

Use two request-owned records:

1. An immutable **attempt fence** is created with exclusive-create semantics. Its mere existence means the exact request may have crossed into side effects. It is never deleted or reclaimed. Partial, malformed, substituted, or otherwise unreadable fence state therefore blocks replay rather than granting ownership.
2. A replaceable **activity record** contains a fresh opaque UUID and bounded heartbeat time. The exact token is also stored in the operation record. Observation reports `running` only when that exact token has a current, strictly validated activity record. Missing, stale, malformed, or substituted activity reports `indeterminate`.

Every execute presentation may start a detached monitor while an operation is still `planned`. Concurrent monitors compete for the immutable attempt fence; only the winner can advance toward execution. A planned operation with no fence remains safely restartable. A planned operation with a fence is indeterminate and is never replayed.

The fence, activity record, and operation record are separate atomic files, so a healthy winner can expose a short cross-file transition. Observation uses a fixed 5/10/20/40/80/160 millisecond reread schedule before returning indeterminate. The window does not delete or reclaim the fence, accept a different token, probe a process, or grant replay. Stress testing must cover fast operations through this publication interval.

Cancellation becomes a request-bound durable message only. The winning monitor polls that message and may terminate only the child it still owns in memory. Timeout follows the same local path. No independent invocation reads a durable PID or issues a termination request from one. While the monitor retains its live child handle, its local child locator is usable for platform tree termination; after child settlement, the monitor never sends another termination request.

The internal operation record moves directly to version 2. Version 1 is rejected closed; there is no compatibility parser or legacy PID field. Completed version-1 request identities can be observed only through their original guest generation, and an unfinished version-1 record cannot be replayed by the new generation.

## Scoped plan

1. Extract a self-contained `operation-activity` module with neutral names and an injected local directory.
2. Make exclusive attempt creation the only exact-effect acquisition and retain the fence permanently.
3. Publish bounded token-bound heartbeats atomically; validate exact schemas, tokens, and freshness.
4. Replace PID-based observation with attempt/activity observation and a terminal-record reread.
5. Remove monitor claims, process-existence probes, and persisted process identifiers.
6. Route cancellation and timeout through the winning monitor's in-memory child lifecycle; fail closed on activity/control-record failures.
7. Include the new helper in both guest image payloads and extend LEGO isolation checks.
8. Test normal, concurrent, partial-fence, stale/substituted activity, cancellation, timeout, restart, fast-child, v1 rejection, and image-membership behavior.
9. Run preflight, the complete suite, hosted Windows and Ubuntu qualification, and exact diff/status checks before closing #367.

## Acceptance boundary

This slice proves guest-local identity and cancellation semantics in deterministic software tests and hosted operating-system runs. It does not prove a physical environment provider, image, transport, VM lifecycle, or the final two-guest C canary. Those remain later acceptance gates.

## Implementation checkpoint

The guest payload now includes one isolated `activity-store.mjs` owner. It creates the permanent attempt fence with exclusive-create semantics, publishes UUID-bound heartbeat records atomically, treats any existing attempt path as non-replayable, strictly validates activity shape/token/freshness, and removes only the exact token's replaceable heartbeat. It has no provider, repository, controller, process, or neighboring-module identity in its contract.

The bridge operation journal is version 2. Persisted PIDs and the old monitor-claim/reclaim code are deleted. `execute` starts replaceable activity processes that compete at the same permanent fence; `observe` uses only the fence, exact durable token, bounded heartbeat, and fixed cross-file reread schedule. `cancel` writes a strict request-bound record and never issues termination itself. Timeout/cancellation tree termination occurs only inside the winner while its child remains live and owned in memory. Version-1 records and injected PID fields fail closed without compatibility handling.

Local evidence on Windows:

- focused activity/bridge/payload/LEGO tests: 35/35 passed;
- fast-child publication stress: 10 consecutive 16-operation runs passed after adding the bounded cross-file observation window;
- repository preflight: 126 syntax files, 2 JSON files, 124 targeted test files passed;
- complete repository suite: 1,667 total, 1,652 passed, 15 expected platform skips, zero failures;
- `git diff --check`: passed.

Hosted Windows and Ubuntu checks must pass on the exact pushed commit before #367 closes.
