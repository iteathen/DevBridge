# HO170 — Preflight deadline ownership and observable progress

Owner: repository preflight and CI composition, #475; qualification dependency of draft PR #492. This is not an installer/UAC/provider deadline change.

## Assessment, research, and reassessment

At `8f85940f683010e73c83e5ce9cb12d9b96ee1dab`, CI33960766066 proves correct Windows npm.cmd argument forwarding, but Windows smoke expires at 180 seconds and serialized full at 360 seconds. Both Ubuntu jobs pass. No test assertion failure is reported before those cancellations. Historical HO055's 214-second, 1,651-test serial measurement does not describe today's suite: HO168's complete local serial run passed 2,372 tests in 399.453 seconds.

A read-only instrumentation run on the unchanged head with exact Node22.16.0 and the existing bounded concurrency measured prerequisites at 16.992 seconds and targeted tests at 137.410 seconds, total 154.402 seconds, passing all 3 artifact / 295 syntax / 2 JSON / 234 targeted-file checks. This is one workstation measurement, not a hosted timing guarantee.

AGENTS, DB-019, the LEGO module contract, implementation/callers/tests, and HO055/HO169 govern the correction. Node's pinned [multiple reporter contract](https://nodejs.org/download/release/v22.16.0/docs/api/test.html#multiple-reporters) supports separate progress and TAP destinations. [spawnSync](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#child_processspawnsynccommand-args-options) supports inherited stdout plus captured stderr and waits for child closure; a timeout is not proof of descendant cleanup. [GitHub workflow limits](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) are enclosing cancellation bounds.

The native failing-fixture test falsified the initial built-in-dot design: Node22's dot reporter also streams assertion details and host paths at failure. It therefore cannot satisfy the bounded payload-free live projection. The correction uses Node's documented custom-reporter port: a small TestsStream adapter emits only pass/fail marks, with a 16-KiB mark allowance (over eight times the current result inventory), line wrapping, and one explicit display-cap notice. It never reads event payloads or parses reporter text; Node remains the sole execution/result owner. TAP stays captured under the existing 4-MiB bound and #316 failure projection. No report file/cache is created.

## Scoped implementation plan

- Keep test inventory, assertions, isolation, Windows preflight concurrency2/full1, npm.cmd forwarding, and all product/candidate-validation deadlines unchanged.
- Preflight owns one 210-second monotonic admission budget, reserving 30 seconds inside existing four-minute candidate-validation parents. Clamp every existing child limit to remaining time; never reset/extend the budget on progress. Keep the 60-second per-check and 180-second targeted maxima. Reject a late successful return rather than declaring it qualified.
- Both hosted preflight steps allow four minutes, matching that existing enclosing profile. Smoke job allows eight minutes: four preflight, two existing one-minute checks, and two minutes for setup/teardown. Windows full allows ten minutes, approximately 1.5 times the measured 399-second serial run, inside a fourteen-minute job (two checks plus two setup/teardown minutes). Ubuntu full remains six minutes. These are finite reviewed cost allowances, not retries or acceptance thresholds.
- Emit synchronous, closed operation start/terminal records with monotonic elapsed/remaining budget before each blocking child. Project Node's completed-result events as bounded marks, not timer heartbeats; retain bounded captured TAP failure evidence. Do not build another test interpreter or process-tree manager.
- Falsify admission, shrinking budgets, late success, classified failures, observer errors, unchanged inventory, reporter wiring, and real child output/termination behavior. Existing synchronous process-tree limitations remain explicit: an enclosing cancellation or direct-child timeout does not prove all descendants stopped. Do not close the broader cancellation/cleanup portion of #475 from this slice.
- Run focused checks before preflight and the complete exact-head Windows/Ubuntu matrix; inspect the full diff and retain author-review provenance. No native install, VM mutation, UAC, or protected integration follows a red matrix.

## Qualification

Four new admission/progress regressions and three workflow budget regressions failed against their old implementations before correction. Focused qualification covers a real standalone reporter subprocess, a real stalled direct-child timeout with retained output, fake-clock deadline exhaustion/late success, stalled observers, invalid clocks/retryability, failure classification, payload suppression and output capping. The standalone CLI fixture removes the inherited Node test-child reporting marker from its own environment; it does not modify product environments. Native fixtures remove their exact temporary roots through test teardown.

Local focused checks pass 22/22 on Node22.16.0. Architecture/product/standalone checks pass 36 with one existing Windows symlink-capability skip; generated products remain current. The new reporter adds one syntax-checked file; the 234 targeted files remain unchanged. Complete local/hosted exact-head qualification is pending. Preserve prior failed runs; do not retry them to erase evidence.
