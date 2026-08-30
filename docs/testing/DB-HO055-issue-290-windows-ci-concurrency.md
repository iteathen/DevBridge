# DB-HO055: deterministic Windows CI test-file concurrency

Status: implemented and accepted through repeated exact-head hosted Windows qualification

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

## Reopened preflight assessment

The full-suite correction did not own the smoke preflight's test-file scheduling. Run `33212636105` attempt 1 on exact head `9cf4155df5887d8df1120dbf13b43a110ab7c420` failed the real CMake capability probe in `environment-bootstrap-agent.test.js` under the smoke preflight's machine-derived test-file concurrency; the same file passed in the serialized full suite on that SHA, and the unchanged smoke rerun passed. Run `33219166402` then reached the smoke job's fixed boundary twice under the same parallel preflight shape. Removing five redundant direct child syntax launches corrected that local composition cost, but it did not bind the remaining targeted-test phase to a deterministic Windows policy.

Assessment is now bound to `stage8/362-protected-activity-channel` at `fd1d6e6536331fa7229d5a7e5a4ff6f188166ec6`. Repository preflight launches 162 selected test files in one Node test-runner process without a concurrency option. Many of those files launch their own Node, Git, compiler, or PowerShell children. The later Windows full suite is serialized, but the earlier Windows smoke preflight is not. This leaves the same external-process resource pressure independently reproducible at two verification tiers.

## Refreshed primary research

- Node.js 22.16.0 documents that `--test-concurrency` is the maximum number of test files run concurrently and otherwise defaults to `os.availableParallelism() - 1`: <https://nodejs.org/download/release/v22.16.0/docs/api/cli.html#--test-concurrency>.
- Node.js 22.16.0 documents that process-isolated matching test files each run in a separate child process and that the concurrency option bounds those children: <https://nodejs.org/download/release/v22.16.0/docs/api/test.html#test-runner-execution-model>.
- GitHub currently documents four processors and 16 GiB of RAM for public-repository `windows-latest` runners: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners#supported-runners-and-hardware-resources>.

Consequently the current Windows smoke preflight normally admits three test-file processes, before counting any children those files launch. This is still a test-resource ownership problem, not evidence for changing a product, compiler, PowerShell, Hyper-V, or guest timeout.

An exact Node 22.16.0 timing probe forced the entire selected test-file phase to concurrency one without editing the repository. The targeted phase completed all 842 tests in 66.4 seconds and the complete preflight reached its result in approximately 101 seconds, within the existing two-minute step and three-minute job ceilings. That probe used an `npx`-materialized runtime and reproduced the already known two environment-bootstrap fixture failures caused by that wrapper's child-runtime environment; it is timing data only, not passing candidate evidence. Exact hosted Node 22 qualification remains the acceptance authority.

## Reassessment and correction plan

Keep scheduling at the CI/preflight composition edge. Production command, provider, guest, bridge, and lifecycle modules must remain unaware of Windows, GitHub Actions, or test-runner topology.

1. Add one closed, neutral preflight option named `serializeTargetedTests`. Its CLI stud is exactly `--serialize-targeted-tests`; no raw concurrency number, environment field, executable, path, or arbitrary Node argument is accepted.
2. Translate that local option inside repository preflight to Node's fixed `--test-concurrency=1` argument for the existing complete targeted-test list. Preserve process isolation, every selected test file, assertions, and the existing three-minute process bound.
3. Reject duplicate, unknown, or value-bearing preflight arguments instead of silently ignoring them. Default callers retain the current machine-derived test-file scheduling.
4. Split only the workflow smoke preflight into mutually exclusive Windows-serialized and non-Windows-default steps. Keep the existing two-minute step and three-minute job ceilings unless exact evidence disproves the measured margin.
5. Add direct option/argument contract tests plus a static workflow proof. Keep the later full-suite policy unchanged.
6. Run focused argument/workflow tests, repeated Windows serialized preflight, default preflight, the complete suite, exact diff checks, and hosted Windows/Ubuntu qualification. Require multiple accepted hosted Windows runs before closing #290 because one prior accepted run did not expose the separate smoke path.

This correction performs no setup, elevation, service/provider/image/environment/VM/guest operation, repository execution through DevBridge, or physical canary.

## Preflight correction implementation

Repository preflight now exposes one closed local option, `serializeTargetedTests`, through the sole CLI argument `--serialize-targeted-tests`. The default remains false. The parser rejects duplicated, value-bearing, raw-concurrency, and unknown arguments. The programmatic contract rejects non-boolean or foreign option fields before running any check.

When selected, the preflight parent adds the fixed Node argument `--test-concurrency=1` only to the existing complete targeted-test invocation. No test file is reclassified, removed, skipped, merged into a shared process, or given a different assertion or timeout. The preflight's syntax, JSON, artifact, compatibility, failure-evidence, and three-minute targeted-process contracts are unchanged.

The workflow is the only Windows-aware composition edge. Its smoke job now selects the closed option only for `runner.os == 'Windows'`; non-Windows smoke keeps the exact default `npm run preflight` command. The existing two-minute step and three-minute job ceilings are unchanged. The already serialized Windows full suite and default non-Windows full suite are unchanged.

Direct option tests prove both invocation shapes contain the same 163 targeted files and differ by only the fixed scheduling argument. Static workflow tests prove mutually exclusive Windows/non-Windows selection and the unchanged deadlines. No generic scheduler, arbitrary concurrency input, production fallback, or legacy argument reader was added.

## Local correction evidence

All checks ran on Windows without UAC/elevation, setup, installed-state mutation, service/provider/image/environment/VM/guest access, DevBridge repository execution, or a physical canary:

- focused parser, programmatic option, workflow, compatibility, and bounded-diagnostic contracts: 12/12 passed under Node 24 and 12/12 passed under exact Node 22.16.0;
- direct exact Node 22.16.0 environment-bootstrap suite: 4/4 passed, confirming the earlier `npx`-wrapped timing probe was not candidate evidence;
- exact Node 22.16.0 serialized repository preflight attempt 1: 200 syntax files, 2 JSON files, 163 targeted test files, passed in 79,282 ms;
- exact Node 22.16.0 serialized repository preflight attempt 2: the same 200/2/163 inventory passed in 77,887 ms;
- exact Node 22.16.0 default repository preflight: the same 200/2/163 inventory passed in 27,082 ms;
- direct unsupported raw-concurrency CLI input failed closed before preflight work;
- complete default-concurrency local suite: 1,810 total, 1,794 passed, 16 expected Windows platform skips, zero failures in 53,984 ms;
- syntax checks and `git diff --check`: passed.

Commit and push the exact candidate, then require multiple complete hosted runs. Each accepted run must pass Windows serialized smoke preflight, Windows serialized full-suite/doctor, and both default Ubuntu jobs without rerunning failed jobs or widening a deadline. Close #290 only after that repeated exact policy evidence.

## Accepted repeated hosted checkpoint

[GitHub Actions run 33283831485 attempt 1](https://github.com/iteathen/DevBridge/actions/runs/33283831485/attempts/1) passed all four jobs on exact implementation commit `146539b3b6decac3de680c255cd394c882485082`. The Windows smoke job selected only the serialized preflight and completed in 1 minute 19 seconds; the Windows serialized full-suite/doctor job completed in 2 minutes 20 seconds. Both default Ubuntu jobs passed.

[GitHub Actions run 33283831485 attempt 2](https://github.com/iteathen/DevBridge/actions/runs/33283831485/attempts/2) reran the complete four-job matrix on the same exact commit. Windows smoke again selected only the serialized preflight and passed in 1 minute 28 seconds; Windows serialized full-suite/doctor passed in 2 minutes 24 seconds; both default Ubuntu jobs passed again.

Neither attempt reran only a failed job, widened a workflow/product/tool timeout, removed a test, skipped a platform, or changed production behavior. The repeated clean matrix satisfies #290's deterministic Windows CI acceptance. Close #290; keep the protected service refresh and physical Stage-7/Stage-8 gates independently open.
