# DB-HO021 — issue #328 Hyper-V prefix probe timeout

Status: implemented, qualified through stacked PR #329, and integrated into `cuda-target` with #326 by PR #327 at `2b5a3635a6aa808373b26dd1409e3e7d68fa5279`.

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

## Implementation

`hyperv-environment.test.js` now names a 60-second hard deadline for only the Windows prefix probe and passes it to the existing direct `execFile()` invocation. The generated PowerShell, executable, arguments, encoding, and hidden-window behavior are unchanged. No production source file changed.

## Local evidence

- Windows prefix probe: 1 focused pass plus 20 consecutive additional focused executions;
- repository preflight: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 40`);
- VM/repository-execution LEGO architecture selection: 21 passed, 0 failed;
- full combined suite with the pending #326 correction: 1,232 total, 1,221 passed, 11 platform skips, 0 failed, with a normal TAP exit in 54.5 seconds.

## Remote evidence

Stacked PR #329 kept the #328 diff isolated against the pending #326 branch. GitHub Actions run `33128271890` passed Ubuntu smoke in 15 seconds, Ubuntu full test in 32 seconds, Windows smoke in 46 seconds, and Windows full test in 2 minutes 34 seconds. PR #329 then squash-merged only into the #326 topic branch.

The resulting exact combined head `2f7ef584e223fcf71b79c4fdd4cda1a95eaa5c0e` passed final PR #327 run `33128452380`, including Windows full test in 2 minutes 9 seconds. PR #327 then squash-merged the green head into `cuda-target`; the isolated #328 branch was removed.
