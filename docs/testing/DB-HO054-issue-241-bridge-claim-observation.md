# DB-HO054: bounded bridge claim publication observation

Status: implemented and verified

Issue: [#241](https://github.com/iteathen/DevBridge/issues/241)

## Assessment

The guest bridge exact-execution fence has a real publication race. `reserveMonitor()` acquires ownership with `open(file, 'wx')`, then writes the `starting` claim JSON through that still-open handle. A concurrent exact request can receive `EEXIST` after the destination directory entry exists but before the winner's write and close have completed. It immediately calls `monitorClaim()`, whose single `lstat`/`readFile`/`JSON.parse` observation can therefore see empty or incomplete bytes, or a transient Windows open failure. The exchange then returns `ok: false` even though another exact caller legitimately owns the fence.

The current isolated test passed 100 consecutive runs on this host. That does not disprove the race: it confirms that scheduler timing is needed to expose the narrow window. The source ordering itself establishes the incomplete-publication state, and the original hosted Windows failure is consistent with it.

There is a second narrow race in the same ownership decision. A claim can disappear after the losing `open('wx')` observes `EEXIST` but before `monitorClaim()` reads it. Absence at that point is a changed observation, not malformed ownership evidence. The caller must retry the existing exclusive acquisition step; it must not infer ownership or spawn without acquiring the same fence.

This is guest-local execution bookkeeping. The repair belongs wholly inside `src/guest/bridge-agent.mjs`; it must not import provider, repository, controller, toolchain, or host topology identities.

## Primary-source research

- Node documents that `wx` is the exclusive create form and fails if the path exists. On Windows it maps `O_EXCL|O_CREAT` to `CREATE_NEW`: <https://nodejs.org/api/fs.html#file-system-flags>
- Node documents that promise-based filesystem operations are not synchronized and that `writeFile` may perform multiple underlying writes. Completion of `open('wx')` therefore does not mean the later asynchronous `writeFile` has completed: <https://nodejs.org/api/fs.html#fspromises-api> and <https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options>
- Microsoft documents that `CREATE_NEW` creates the file when it does not exist and that conflicting opens can fail while another handle's sharing restrictions remain active: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea>

The sources support the ordering defect but do not justify treating arbitrary malformed claims as valid or retrying every filesystem error.

## Reassessment

Changing operation timeouts, weakening request/body identity, treating malformed claims as absence, or allowing a second monitor would violate the exact-effect contract. Replacing the claim representation with a new multi-file or platform-specific lock protocol would be broader than required.

The smallest complete repair is bounded observation of only an already-existing claim publication:

- retain `open('wx')` as the sole ownership acquisition operation;
- after `EEXIST`, retry only transient incomplete-publication evidence: JSON syntax failure and Windows-style `EPERM`, `EACCES`, or `EBUSY` open/read failures;
- use a fixed short schedule owned by the guest helper; callers cannot widen it;
- validate the fully read claim exactly as before;
- after bounded exhaustion, propagate the final error and fail closed;
- when the claim disappears, retry exclusive acquisition through the existing bounded reservation loop;
- never turn observation success into ownership and never spawn without an acquired token.

## Plan

1. Add fixed claim-publication retry bounds and a local predicate that recognizes only the evidenced transient read classes.
2. Make `monitorClaim()` perform bounded observation while preserving immediate `ENOENT` and non-transient failure behavior.
3. Make `reserveMonitor()` reconcile claim disappearance by returning to `open('wx')` rather than declaring the claim invalid.
4. Add deterministic tests for delayed completion, permanent malformed bytes, non-transient errors where practical, and disappearance/reacquisition.
5. Strengthen concurrent exact-execute coverage with repeated simultaneous callers while preserving the exact one-side-effect assertion.
6. Run focused tests, repository preflight, the complete suite, and `git diff --check`.
7. Record exact implementation/test evidence, push the checkpoint, and close #241 only if all acceptance criteria are satisfied. Update broader Windows concurrency issue #290 without closing it unless its separate acceptance is complete.

## Protected-operation constraint

The operator has stated that UAC is unavailable for three days. This work is ordinary guest-helper source and unprivileged local test execution only. It must not request elevation, invoke setup, operate providers/services/VMs, run guest transports, or change installed state.

## Implementation

`src/guest/bridge-agent.mjs` retains the existing request-owned exclusive `open('wx')` fence. Its local claim observer now:

- retries a JSON `SyntaxError`, which is the exact empty/partial-byte evidence produced during the winner's asynchronous write;
- on Windows only, retries `EPERM`, `EACCES`, and `EBUSY` from the same claim open/read window;
- uses the fixed 5, 10, 20, 40, 80, and 160 millisecond schedule, for at most 315 milliseconds of waiting;
- immediately returns absence on `ENOENT` and immediately propagates every other error;
- propagates the exact final transient error after bounded exhaustion; and
- leaves claim shape, token, state, PID/liveness, age, request/body identity, and stale-claim decisions with their existing owner.

If a prior `EEXIST` observation changes to `ENOENT`, `reserveMonitor()` now performs its second existing bounded exclusive-open attempt. It does not treat absence as ownership and cannot spawn a monitor without receiving a newly generated token from a successful exclusive creation.

No protocol, record schema, provider attachment, host controller, route, program admission, timeout, operation-state transition, or external interface changed. The guest helper remains self-contained and contains no provider, repository, controller, or neighboring-module identity.

## Verification evidence

- focused bridge-agent suite: 16 passed, 0 failed;
- controlled delayed publication: an incomplete claim is finished while an exact concurrent exchange is observing it; the caller succeeds, no monitor is stolen, and exact replay later produces one side effect;
- controlled disappearance: an incomplete claim is removed during observation; the caller returns to exclusive acquisition and produces one side effect;
- permanent malformed claim: bounded observation ends in `operation-failed` within two seconds and the forbidden side effect is absent;
- concurrent stress in the focused test: six exact operations, four simultaneous callers each, all callers successful, one side effect per operation;
- ten additional isolated repetitions: 240 concurrent execute calls across 60 exact operations, all passed with one side effect per operation;
- repository preflight: 124 syntax files, 2 JSON files, and 119 targeted test files passed;
- complete repository suite: 1,651 total, 1,636 passed, 15 expected platform skips, 0 failed;
- `git diff --check`: passed;
- no setup, UAC request, provider/service/VM operation, installed-state change, guest transport, media/activation effect, or host repository-code execution occurred.

Issue #241 can close with this checkpoint. The broader hosted-Windows process-pressure investigation in #290 remains separate and must not be closed by this bridge-specific repair.
