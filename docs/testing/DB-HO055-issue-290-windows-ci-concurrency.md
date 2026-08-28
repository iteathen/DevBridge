# DB-HO055: deterministic Windows CI test-file concurrency

Status: implemented and accepted on hosted Windows

Issue: [#290](https://github.com/iteathen/DevBridge/issues/290)

## Assessment

The hosted Windows failures are test-infrastructure contention rather than a demonstrated production timeout defect:

- run `32905874344`, exact head `8cac30374a57deed606e52090db2d83aee75ecd9`, terminated the real PowerShell prefix probe at 20,075 ms in the full Windows suite;
- the same test passed on the unchanged rerun evidence recorded in #290 and again on the later exact head `b8bf9c2cb61ef8c5bf840d9ce4965b24e6468906`;
- the current suite has 26 test files that name or launch PowerShell-related behavior, while `npm test` leaves test-file concurrency at Node's machine-derived default;
- the three historically failing PowerShell/Hyper-V tests pass locally at approximately 1.1, 1.1, and 2.9 seconds when test files are serialized;
- the complete current Windows suite passes serially in 214,705 ms: 1,651 total, 1,636 passed, 15 expected platform skips, 0 failed.

The existing CI `Tests` step has a six-minute limit and its job has a ten-minute limit. The measured serial suite fits both with more than two minutes of step headroom. Linux has no corresponding failure evidence and should retain its ordinary default concurrency.

A post-change default-concurrency run also exposed a distinct fixture error in `bridge-agent-observation.test.js`: the test spawned a process, waited for exit, persisted that released PID as a dead monitor, then started another process to observe it. Under load Windows reused the PID, so the test's new observer was the live process found by `process.kill(pid, 0)`. Microsoft explicitly documents PID reuse. The test therefore did not control the identity it asserted was dead.

This discovery also exposes a broader product limitation: the current guest journal binds monitor and child liveness to durable numeric PIDs, which cannot distinguish a later occupant after reuse. That is now tracked independently in [#367](https://github.com/iteathen/DevBridge/issues/367), including cancellation-target correctness. CI serialization must not be represented as that product fix.

This policy belongs at the CI composition edge. Production command, provider, guest, bridge, and lifecycle modules must not learn CI runner identity or test scheduling.

## Primary-source research

- Node 22.16 documents that the CLI test runner uses process isolation and that `--test-concurrency` controls the maximum number of test files executed concurrently. Without an explicit value it defaults to `os.availableParallelism() - 1`: <https://nodejs.org/download/release/v22.16.0/docs/api/cli.html#--test-concurrency>
- Node's test-runner execution model states that each matching test file is executed in its own child process under process isolation: <https://nodejs.org/download/release/v22.16.0/docs/api/test.html#test-runner-execution-model>
- GitHub documents four processors and 16 GB RAM for public-repository standard `windows-latest` runners. DevBridge is currently public, so Node normally admits up to three test-file processes before accounting for subprocesses spawned inside those files: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners#supported-runners-and-hardware-resources>

## Reassessment

Increasing Hyper-V or general product timeouts, weakening real-PowerShell assertions, adding retries around failed tests, or disabling Windows coverage would misclassify infrastructure pressure as product behavior. A cross-platform serial default would unnecessarily increase Linux cost without evidence.

The smallest complete policy is:

- retain the existing full suite and six-minute step limit;
- run the Windows full suite with exact test-file concurrency `1`;
- run the non-Windows full suite through the unchanged `npm test` command;
- leave smoke and repository-execution architecture gates unchanged because they already select one or a small bounded file set and are not the observed contention site;
- add a static workflow contract test so later edits cannot silently restore machine-derived Windows full-suite concurrency or serialize every platform.
- replace the released-child-PID fixture with a deterministic positive safe integer that the local process API cannot observe, and rename the test to its exact narrower assertion; do not change production PID behavior in this slice.

This is a current CI composition policy, not a portable resource scheduler and not implementation of the full DB-019 program.

## Plan

1. Split only the workflow's full-suite step into Windows-serial and non-Windows-default branches using the runner's local OS fact.
2. Preserve the exact `npm test` coverage command; add only `--test-concurrency=1` to the Windows branch.
3. Add a static contract test for mutually exclusive conditions, preserved non-Windows command, and exact Windows concurrency.
4. Remove the released-PID fixture race and keep the non-observable-record assertion deterministic; preserve #367 as the product owner for reusable PID identity.
5. Run the workflow/observation contract tests, repository preflight, default complete suite, and `git diff --check`.
6. Use the already completed exact serial full-suite measurement as local timing/coverage evidence.
7. Push the checkpoint and use the resulting hosted Windows run as the final environment-specific acceptance gate before closing #290.

## Protected-operation constraint

The operator has stated that UAC is unavailable for three days. This slice edits repository workflow/test/docs only and uses unprivileged local tests plus hosted CI. It must not request elevation or operate local providers, services, VMs, guest transports, setup, or installed state.

## Implementation

`.github/workflows/ci.yml` now has two mutually exclusive full-suite steps:

- non-Windows runners retain the exact `npm test` command and Node's ordinary default concurrency;
- Windows runs the same complete suite through `npm test -- --test-concurrency=1`;
- both retain the existing six-minute step limit;
- the job's architecture gates and doctor remain in their original order and retain their existing limits.

No test path, assertion, skip, product timeout, provider behavior, guest behavior, or production source changed for the scheduling policy.

`test/public-repository.test.js` owns the static workflow contract. It requires both mutually exclusive runner conditions, the exact Windows concurrency, unchanged non-Windows command, and unchanged six-minute limits.

`test/bridge-agent-observation.test.js` no longer releases an actual child PID and then assumes that numeric value still denotes the exited child. It supplies a deterministic positive safe numeric identity that `process.kill(pid, 0)` cannot observe and names the assertion accordingly. This preserves the intended non-observable-record result without claiming to test reusable PID identity. #367 owns the broader product correction.

## Local verification evidence

- exact current focused workflow/observation contracts: 4 passed, 0 failed;
- exact npm argument-forwarding smoke: `npm test -- --test-concurrency=1 test/public-repository.test.js`, 3 passed, 0 failed;
- pre-implementation full serial measurement on the same source/test product head: 1,651 total, 1,636 passed, 15 expected skips, 0 failed in 214,705 ms;
- first post-policy default-concurrency run reproduced the released-PID fixture race and did not become passing evidence: 1 failure, correctly investigated rather than hidden;
- post-containment repository preflight: 124 syntax files, 2 JSON files, and 119 targeted test files passed;
- post-containment default-concurrency complete suite: 1,652 total, 1,637 passed, 15 expected platform skips, 0 failed in 57,377 ms;
- `git diff --check`: passed;
- no setup, UAC request, provider/service/VM operation, guest transport, installed-state mutation, or host repository-code execution occurred.

Hosted CI run `33204210686` on exact implementation commit `60182c978f4d97c9d03b631258cc617d35fc5252` passed the complete Windows suite through the committed serialized step in 2 minutes 14 seconds, then passed the doctor smoke. The same run also passed Windows preflight/installer smoke and both Ubuntu jobs. No product timeout, test assertion, test file, or Windows coverage was removed. This satisfies #290 acceptance; #367 remains open independently because reusable process identity is a separate product problem.
