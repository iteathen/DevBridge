# DB-HO021 — issue #328 Hyper-V prefix probe timeout

Status: planned from exact `cuda-target` baseline `67a4b0607d9e4b359395570e5259cdca9cc1259a` on isolated branch `test/328-hyperv-prefix-probe-timeout`.

## Assessment

The Windows-only prefix-arithmetic test intentionally extracts the actual generated PowerShell functions and executes them across all IPv4 prefix lengths. Its child process has a fixed 20-second timeout. In PR #327's Windows full-suite job, parallel load caused that process to reach 20,044 ms and be terminated before it returned output. The error contains no arithmetic assertion failure; later tests ran and the suite emitted a normal TAP summary.

The generated network logic, its production command boundary, and the test's real-interpreter purpose remain correct. The defect is the test-local hard deadline, which does not cover observed Windows CI load.

## Research and reassessment

Node's official `child_process.execFile()` documentation defines `timeout` as a millisecond limit on the spawned process and keeps `shell` disabled by default. It also documents `windowsHide` as the option that suppresses the child window. The observed `Command failed` at the configured boundary is therefore expected timeout behavior, not a semantic PowerShell result.

Primary source:

- [Node.js child process — `execFile()`](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)

A 60-second test-local hard deadline gives three times the observed threshold while remaining explicit and bounded under DB-019. Removing the timeout, replacing real interpreter execution with a JavaScript duplicate, or changing production Hyper-V logic would weaken the evidence.

## Plan

1. Give the real prefix probe one named 60-second test-local hard deadline.
2. Preserve direct `execFile()` invocation, fixed arguments, UTF-8 output, noninteractive mode, execution-policy selection, and hidden Windows window.
3. Keep every arithmetic assertion and the real generated PowerShell source unchanged.
4. Run the Windows-only focused test repeatedly, repository preflight, the 21-test VM/LEGO architecture selection, and the full suite before isolated publication.

This slice changes no production Hyper-V/network, provider, VM, repository-execution, setup, elevation, or runtime authority. It invokes no UAC or physical provider action.
