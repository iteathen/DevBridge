# DB-HO052: bounded daemon-control record reads

Status: implemented and verified

Issue: [#366](https://github.com/iteathen/DevBridge/issues/366)

## Assessment

Two consecutive complete Windows test runs failed after an immutable daemon record had been atomically published:

- `stopDaemon waits for the lock owner to release instead of deleting its lock` received `EPERM` opening the active daemon lock;
- after the owning lock suite passed 3/3 in isolation, a fresh complete run failed `pause and resume records bind to the current daemon lock token` with `EPERM` opening the exact pause acknowledgement.

The failures affected different records but the same owner: `readDaemonLock` and `readControlRecord` each call `readFile` once and treat every error other than `ENOENT` as terminal. The isolated owner suite passing shows that the serialized bytes and token/PID bindings are not intrinsically invalid. Repetition across two immutable record types makes this a product reliability defect, not acceptable test noise.

DB-018 requires token-bound cooperative pause/resume/stop. DB-009 requires bounded observation and reconciliation rather than an unbounded generic retry. A transient inability to open a record is not evidence that the record is absent, malformed, or owned by someone else.

## Primary-source research

- Microsoft documents that a Windows `CreateFile` open fails when its requested access conflicts with the sharing mode of another live handle, and that sharing restrictions remain until that handle closes: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea>
- Node documents Windows-specific `EPERM` filesystem behavior. Its filesystem API also uses bounded retry/backoff for selected operations that can encounter transient `EPERM`, supporting the same bounded-classification approach rather than infinite retry: <https://nodejs.org/api/fs.html>

The observed Node error is `EPERM`, so the initial classification remains exactly that code. `EACCES`, `EBUSY`, malformed JSON, schema mismatch, token mismatch, and PID mismatch are not generalized into the same class without evidence.

## Reassessment

Changing atomic publication, weakening token checks, treating `EPERM` as absence, or increasing every daemon timeout would be incorrect. The smallest complete repair is one topology-neutral text-read primitive with a fixed short retry schedule:

- return exact text immediately on success;
- retry only `EPERM`;
- use a bounded exponential delay totaling far less than an ordinary daemon-control deadline;
- propagate `ENOENT` so the owning daemon component retains its absence semantics;
- propagate every other error immediately;
- rethrow the exact final `EPERM` after exhaustion;
- never retry parsing, schema, ownership, token, or PID failures.

The daemon-lock owner attaches this primitive only at its immutable record-read studs. It continues to own all path derivation, absence interpretation, record validation, effects, and timeouts.

## Plan

1. Add an import-free `bounded-text-read` value/operation module with injected read/wait ports for deterministic tests.
2. Fix the product schedule locally; callers cannot widen retry codes, count, or timing.
3. Replace only daemon lock/control-record `readFile` calls with the new primitive.
4. Test transient recovery, exact exhaustion, non-`EPERM` immediate failure, byte preservation, and module isolation.
5. Run daemon lock/governance tests, candidate preflight, and the complete repository suite.
6. Document exact results, commit/push the repair, update and close #366 only if the boundary is fully addressed.

## Protected-operation constraint

The operator has stated that UAC is unavailable for three days. This repair is ordinary filesystem/control-plane code only. It must not request elevation, touch services/providers/VMs, or perform guest work.

## Implementation

`src/runtime/bounded-text-read.js` now owns the narrow local operation. It has no daemon, setup, provider, repository, guest, controller, or platform identity. Its contract:

- reads exact UTF-8 text through an injectable local read port;
- retries only `EPERM` after fixed 5, 10, 20, 40, and 80 millisecond waits;
- allows six total observations and at most 155 milliseconds of waiting;
- returns successful bytes unchanged;
- propagates `ENOENT`, `EACCES`, `EBUSY`, and every other failure immediately;
- rethrows the exact final `EPERM` after exhaustion; and
- exposes no caller option that can widen the retry class, schedule, or attempt count.

The daemon-lock owner uses this stud for lock/control-record reads and for observing an already-published immutable control record after a rename collision. It still owns path derivation, `ENOENT` interpretation, JSON/schema validation, PID/token ownership, publication, cleanup, and control deadlines. The diagnostic-only best-effort detail read during a lock-acquisition collision remains outside this correctness path.

No publication protocol, record schema, timeout, token rule, parser, or external interface changed. No broad retry loop or Windows-specific identity entered the reusable primitive.

## Verification evidence

- focused text-read, LEGO, daemon-lock, daemon-governance, and setup-journal recovery tests: 27 passed, 0 failed;
- repository preflight: 122 syntax files, 2 JSON files, and 115 targeted test files passed;
- complete repository suite: 1,634 total, 1,619 passed, 15 expected platform skips, 0 failed;
- `git diff --check`: passed;
- no installed setup, UAC request, provider/service/VM operation, guest command, or media/activation effect occurred.

The deterministic tests prove transient recovery and the exact `[5, 10, 20, 40, 80]` schedule, exhaustion with exact final-error identity, immediate propagation of `ENOENT`/`EACCES`/`EBUSY`, byte preservation, malformed-content ownership, malformed local-port rejection, and isolation from current topology identities. The two previously failing daemon owner suites pass both focused and within the complete concurrent suite.

Issue #366 can close with this checkpoint. A future observed failure with another code or filesystem operation must be assessed from its own evidence rather than widening this classification implicitly.
