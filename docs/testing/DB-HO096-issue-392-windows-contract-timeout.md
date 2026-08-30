# DB-HO096 — Windows contract-child hard-timeout correction

Date: 2026-08-30

Status: assessment, research, reassessment, and implementation plan recorded

Coordinates with: #392, DB-009, DB-019, DB-020, and DB-HO095.

GPU/CUDA work is outside this checkpoint.

## Scope

This checkpoint owns only the hard timeout and failure diagnostics of the real-Windows PowerShell contract child used by the Hyper-V construction partial-effect regression test. It may change the test and its documentation. It must not change production process timeouts, provider behavior, construction scripts, setup/elevation, protected state, a VM/guest, repository execution, or model routing.

## Assessment

The documentation-only DB-HO095 head `690c6a15e8d9f8356f700b899a6fb5dafd70ea39` changed only Markdown. [GitHub Actions run 33311082103](https://github.com/iteathen/DevBridge/actions/runs/33311082103) passed Ubuntu smoke/full and Windows bounded smoke but failed the Windows serialized suite at test 632, `Windows Hyper-V construction reconciles only the exact default-adapter New-VM partial effect`.

The first fixed PowerShell child ran for the configured 20,000 ms hard timeout and was terminated. The test observed `exitCode: null` at line 564 after 20,128 ms. The remaining 1,972 tests completed; there was no assertion showing that the construction contract accepted foreign state or performed the wrong reconciliation. Exact implementation head `2bbc9d71acb4cdd1a2299e4a2781d4fb30421879` had passed all four hosted jobs in run 33310910845. Three exact Node 22.16.0 local repetitions of the focused test pass in 1.03–1.05 seconds.

## Primary-source research

The [Node.js child-process documentation](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html) states that a timeout sends the selected termination signal and that a signal-terminated child reports a null exit code. It also distinguishes the `close` event, emitted after process termination and stdio closure, from a successful numeric exit.

GitHub's [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) defines the supported Windows hosted runner as a managed x64 four-vCPU environment. Its transient process-start and inspection latency is external to this test's deterministic script, while the workflow's six-minute job timeout remains the suite-level liveness boundary.

## Reassessment

The exact `null` result and wall time match the child hard timeout, not a Hyper-V policy assertion. A supported hosted observation proves that 20 seconds is below a reliable hard bound for this fixed Windows contract child. Blindly rerunning the failed job would not correct the unstable evidence boundary.

Do not remove the timeout or convert timeout to a skip. Use a test-specific 60-second child hard timeout, still well below the six-minute serialized job bound, and assert `timedOut === false` before interpreting exit code or output. The production `invokeCommand` maximum and defaults remain unchanged.

## Plan

1. Give only this fixed contract child a named 60-second hard timeout.
2. Assert non-timeout explicitly for the exact, foreign-configuration, and foreign-adapter cases before their existing exit/output assertions.
3. Run repeated focused Windows tests, exact-Node preflight, architecture/product/standalone gates, the complete exact-Node serialized suite, doctor, generated-artifact, and diff hygiene.
4. Require all four hosted Ubuntu/Windows jobs on the exact implementation and following documentation heads before closing #392 or accepting DB-HO095's documentation head.

No production timeout or behavior change is authorized.
