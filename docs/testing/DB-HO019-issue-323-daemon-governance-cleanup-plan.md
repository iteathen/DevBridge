# DB-HO019 — issue #323 daemon-governance cleanup

Status: implemented and locally qualified from exact `cuda-target` baseline `7148efb88bbc15c1237dfb42b7f1578fdcb3e87b` on isolated branch `test/323-daemon-governance-cleanup`.

## Assessment

`runDaemon()` already owns its exact lock release in a `finally` block and accepts an `AbortSignal`. The lock release is token-bound and idempotent. The two governance tests that start a daemon, however, rely only on reaching their normal stop assertions. If a short polling deadline expires first under full-suite load, the test body rejects while its daemon promise remains alive. The worker then retains the daemon loop and the full suite cannot emit a final TAP verdict.

The first governance test has the same structural weakness for its directly acquired lock: release occurs only on its successful path. This is test-resource ownership leakage, not a product lifecycle defect.

## Research and reassessment

Node's official test-runner documentation defines `TestContext.after()` as a hook that runs after the current test finishes and permits an async hook with a bounded timeout. DevBridge requires Node `>=22.16.0`, well after the API was added in Node 18.13.0/19.3.0.

Primary source:

- [Node.js test runner — `context.after()`](https://nodejs.org/api/test.html#contextafterfn-options)

The correct ownership boundary is therefore a test-local daemon handle registered immediately with the current test context. It should abort and await only the promise it created; product stop/pause/lock mechanics remain unchanged. Control assertions should use a suite-specific deadline large enough for normal parallel load while remaining bounded under DB-019.

## Plan

1. Add one test-local helper that creates an `AbortController`, starts one daemon with its signal, creates an idempotent cleanup action, and immediately registers that action with the supplied test context.
2. Make cleanup abort and await the exact daemon promise so `runDaemon()` releases only its own token-bound lock.
3. Register the direct lock release with the first test's `after` hook immediately after acquisition.
4. Retain normal pause/resume/stop assertions; cleanup is a failure-path safety net, not a replacement for behavioral verification.
5. Replace the load-sensitive 2–3 second waits with one explicit 10-second governance deadline while preserving short polling.
6. Add a regression using the same registered cleanup action that simulates a primary body failure before normal stop, proves the original failure remains observable, and proves the daemon lock is released.
7. Run the focused file repeatedly, the repository preflight, architecture gates, and the full suite. Require a normal bounded TAP result.

This slice changes no daemon, lock, provider, VM, repository-execution, setup, elevation, or runtime authority. It invokes no UAC or physical provider action.

## Implementation

`daemon-governance.test.js` now creates each test daemon through one local lifecycle helper. The helper:

- creates a private abort controller for exactly one daemon invocation;
- passes that signal through the daemon's existing local contract;
- registers cleanup immediately with the current test context;
- makes cleanup idempotent;
- aborts and awaits the exact daemon promise, allowing its token-bound `finally` release to complete.

The direct lock test likewise registers its already idempotent release action immediately. Normal pause, resume, and stop behavior remains asserted before cleanup. One explicit 10-second governance deadline replaces the previous 2–3 second load-sensitive deadlines while retaining 10-millisecond test polling. A regression throws a designated primary error before any normal stop, invokes the same registered cleanup action, proves that exact error remains observable, verifies the lock is absent, and re-invokes cleanup to prove idempotence.

No production source file changed.

## Local evidence

- focused suite: 4 passed, 0 failed;
- 10 consecutive additional focused executions: all passed;
- repository preflight: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 40`);
- VM/repository-execution LEGO architecture selection: 21 passed, 0 failed;
- full suite: 1,232 total, 1,221 passed, 11 platform skips, 0 failed, with a normal TAP exit in 53.8 seconds.
