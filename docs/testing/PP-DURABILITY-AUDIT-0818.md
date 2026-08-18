# PATCH-POLLER durability campaign audit — 2026-08-18

Status: documentation-only record of the live durability campaign. This file records what was actually learned from issues #4 through #17 and why the next architecture slice exists. It is not an executable task.

## Executive conclusion

The campaign demonstrated two distinct eras:

1. Early tests delegated deterministic machine work to a general coding/model tool. Those runs were slow, ambiguous, token-expensive, and often tested the model-side shell/sandbox rather than PATCH-POLLER itself.
2. Later tests moved deterministic behavior into PATCH-POLLER-owned code. Those runs became short, trustworthy, reproducible, and easy to classify, but each new experiment required another bespoke built-in diagnostic/profile.

The next architecture slice must preserve the second era's trust model while removing the bespoke-profile tax. The preferred path is:

`Chat controller -> PATCH-POLLER -> locally registered deterministic operations -> verification -> seal/publish`

Codex-family models, Spark, and other coding models are not part of the preferred implementation path. They remain optional compatibility/test adapters only when explicitly authorized for a test that actually targets them.

The required generalization is specified in `specs/PP-013-controller-plans.md`.

## Tests and lessons

### Issue #4 — first live tracked-file smoke

Goal: exercise trusted issue polling, managed worktree isolation, proposal creation, candidate validation, PATCH-POLLER-owned Git sealing, and publication with one tiny file.

Observed:

- The first result failed because the tool result omitted the required non-empty `summary`.
- The worker attempted to reason about staging/tracking and hit the intentionally non-writable linked-worktree Git index even though PATCH-POLLER owns Git state.
- Candidate repair consumed multiple turns around BOM/CRLF/trailing-whitespace representation before the simple file was finally sealed and published.
- The eventual end-to-end result was successful, proving the control plane, but the path was much longer than the work justified.

What should be better:

- Chat-authored file proposals should be materialized directly by PATCH-POLLER from a bounded file bundle; no worker should stage or decide whether a file is "tracked."
- Text representation canonicalization must distinguish harmless encoding/newline representation from semantic content changes.
- Exact file bytes and expected-path assertions should be first-class deterministic assertions.

### Issue #5 — context roundtrip

Goal: prove that context sent from the primary chat controller survives PATCH-POLLER, reaches the execution boundary, returns through GitHub status, and can be verified.

Observed:

- The first attempt wrote otherwise-valid JSON with a UTF-8 BOM and PATCH-POLLER rejected it.
- This led to representation-tolerant result parsing: one BOM, ordinary whitespace/newlines, and later one unambiguous Markdown JSON fence can be canonicalized without weakening semantic validation.
- Exact context relay was ultimately proven, but echoing the entire prior summary through a worker is an unnecessarily expensive way to prove identity.

What should be better:

- Every result/context should automatically carry a controller-input receipt: canonical input/context SHA-256, sequence, task revision, and handoff digest where present.
- Exact payload echo remains available only when the payload itself is under test.

### Issue #6 — first capability-boundary matrix

Goal: inspect project read/write, child process streams/exit, outside-project read/write, environment scrubbing, and cwd containment.

Observed:

- The test became dominated by PowerShell quoting and result-construction complexity.
- Several observations were ambiguous or wrong because the instrumentation failed before the security boundary could be measured cleanly.
- Expected denials were hard to distinguish from instrumentation failure.

What should be better:

- Capability tests must be PATCH-POLLER-owned deterministic probes, never generated shell programs.
- A built-in capability doctor should separately test the ProcessRunner, filesystem policy, environment scrub, and each registered tool profile.

### Issue #7 — Node-based capability retry

Goal: remove PowerShell quoting from the matrix and use one project-local Node controller.

Observed:

- Project-local create/read/overwrite/read/delete worked and cleanup succeeded.
- The requested `package.json` was absent because the task worktree baseline came from `main` while the running/testing runtime lived on `sol/foundation-bootstrap`.
- Node executable stat/read worked, but nested process spawning was denied by the model/tool sandbox, making process observations a property of that adapter rather than PATCH-POLLER's own process runner.

What should be better:

- Baseline selection must be local/control-plane-owned and channel-based. Self-hosted testing tasks should resolve the locally configured testing baseline, then persist its exact SHA immutably for the run.
- Capability doctor output must identify which layer is being tested: PATCH-POLLER core vs. a particular external adapter.

### Issue #8 — focused stream/containment probe

Goal: separate a genuine outside-worktree write from special TEMP writability and directly inspect stdout/stderr/exit reporting.

Observed:

- README identity read succeeded.
- Non-special parent write was denied with `EPERM`; parent stat read was allowed.
- TEMP write/read/delete succeeded, which is a special sandbox allowance rather than a generic workspace escape.
- Nested `spawnSync` was denied with `EPERM`.
- Direct model-side command execution surfaced both stdout/stderr markers but reported exit `1` instead of the requested `23`.

What should be better:

- Exact process exit/stream tests should use PATCH-POLLER's ProcessRunner directly.
- Model-side command-tool behavior must not be inferred to describe PATCH-POLLER core behavior.
- Capability reports should identify special writable roots such as TEMP separately from general outside-project write authority.

### Issue #9 — fenced-result tolerance attempt

Goal: write one otherwise-valid result object inside one Markdown JSON fence.

Observed:

- The intended parser behavior was never exercised because Spark hit `Selected model is at capacity` first.
- The worktree remained clean.
- This exposed a different durability gap: a recognizable transient provider-capacity failure was terminalized as a generic tool exit.

What should be better:

- Protocol fixtures such as BOM/fence/truncation/schema tests must be deterministic PATCH-POLLER fixtures, not model tasks.
- Recognized transient provider failures require bounded classification, persisted retry/backoff, and restart-safe continuation.

### Issue #10 — compiler-chain attempt through Spark

Goal: discover a local compiler and perform success -> intentional compiler failure -> repair-success.

Observed:

- Spark searched its own visible PATH and found none of `cl`, `clang-cl`, `clang`, `clang++`, `gcc`, or `g++`.
- A valid structured `blocked` result was written, but the wrapper later hit model capacity and exited nonzero; the wrapper exit obscured the more useful structured evidence.
- Git ownership/safe-directory noise and temporary probe cleanup further complicated the run.
- The model consumed substantial work for a task that should be entirely local/toolchain-owned.

What should be better:

- Compiler/toolchain discovery is local machine authority and belongs to PATCH-POLLER.
- Conservative structured `blocked`/`failed` evidence must survive a later wrapper nonzero exit.
- Native toolchain adapters must be locally discovered/registered and exposed only by logical names/capabilities, never remote paths.

### Issue #11 — fenced-result live retest

Goal: validate the result canonicalization hardening.

Observed:

- The fenced result was accepted end-to-end with a clean unchanged worktree.
- The test still used Spark simply to write a known fixture and consumed model tokens unnecessarily.

What should be better:

- Keep the parser behavior, but move all such protocol mutation tests into deterministic fault/fixture infrastructure.

### Issue #12 — PATCH-POLLER-owned native compiler diagnostic

Goal: prove local compiler discovery and compile-error recovery without a coding model.

Observed:

- MSVC was discovered locally.
- Valid compile succeeded.
- Intentional syntax errors produced real diagnostics.
- Repair in the same workspace compiled successfully.
- Warning capture worked.
- No tracked project changes remained.

Lesson:

- Moving deterministic machine work into the control plane produced much stronger evidence with far less ambiguity.

What should be better:

- Do not create a bespoke profile for every scenario; express compile steps and assertions through a general controller plan referencing a locally registered native toolchain operation.

### Issue #13 — native compile/link/execute durability

Goal: extend the deterministic native diagnostic through link and process execution.

Observed:

- Valid compile/link succeeded.
- Native executable stdout marker was captured with exact process exit code `17`, proving PATCH-POLLER preserves real exit status.
- Intentional unresolved-symbol link failure produced `LNK2019`/`LNK1120` evidence and real exit status.
- Repair/relink/re-execute succeeded in the same workspace.

Lesson:

- The earlier `23 -> 1` anomaly belonged to the model-side command layer, not PATCH-POLLER's ProcessRunner.

What should be better:

- Generalize native compile/link/run into registered deterministic tool operations usable by controller plans.

### Issue #14 — deterministic transient recovery

Goal: reproduce the exact observed model-capacity failure twice, then succeed on attempt three without invoking a provider.

Observed:

- Attempt 1 classified transient and persisted a 5-second retry.
- Attempt 2 classified transient and persisted a 10-second retry.
- Attempt 3 completed in the same durable run.
- Restart-aware backoff and bounded turn-window behavior were implemented and proven.

What should be better:

- Introduce a generic local-only fault-injection framework instead of a bespoke transient profile.
- Test mode may use a bounded time scale so deterministic durability tests do not need production-length waits; production backoff semantics remain unchanged.

### Issue #15 — Spark greenfield C project

Goal: see whether PATCH-POLLER + Spark could turn a concise project brief into a coherent multi-file C project.

Observed:

- The project was created, built with CMake/MSVC, tested, cleaned, sealed, and published.
- The task remained remotely `STARTED` for several minutes, making healthy long-running work indistinguishable from a hang.
- Independent review found defects the generated tests missed: uint64 seed overflow handling, CLI help/error semantics, and weak determinism assertions that compared generated results to themselves instead of a fixed golden/output contract.

What should be better:

- Coding-model generation is no longer the preferred workflow.
- Long-running external operations need sparse/coalesced liveness projection (`stage`, `elapsed`, `lastOutputAt`, `deadline`) without GitHub comment spam.
- Verification should favor fixed golden values and executable-level behavior where the contract is externally visible.

### Issue #16 — chat-only greenfield C project

Goal: perform a comparable small greenfield project using only the primary chat controller plus PATCH-POLLER/local tools.

Observed:

- No Codex/Spark/coding model participated in the live task.
- The chat-authored C11 telemetry project was materialized, built, tested, executed twice byte-for-byte, checked against a fixed golden record, checked for seed overflow and CLI semantics, cleaned, sealed, and published.
- Windows and Ubuntu CI also passed the exact fixture.
- This demonstrated the preferred execution architecture.

Inefficiency:

- To transmit the chat-authored project we first had to embed the source in a new PATCH-POLLER built-in profile. That is safe but not scalable.

What should be better:

- Add a controller-plan/file-bundle protocol so the chat controller can submit bounded project file proposals and deterministic verification intent as data, without changing PATCH-POLLER source for every task.

### Issue #17 — create/run temporary test + context/result roundtrip + cleanup

Goal: prove one no-model lifecycle can create a temporary test, run it, publish test evidence together with returned context, clean every test/runtime temporary artifact, and finish with no project diff.

Observed:

- A generated test source and context fixture were created.
- The generated test ran with exit 0 and emitted the exact nonce marker.
- The test created a nested runtime scratch artifact and PATCH-POLLER observed it.
- The same final `patch-poller/context-v1` contained the original nonce and the test/cleanup evidence.
- Test source, fixture, scratch artifact, and temporary directory were all removed before completion.
- `changedFiles` was empty; base/head were identical; GitHub branch comparison independently reported no difference.

Pre-live lesson:

- A syntax error in the newly added regression test was caught by CI before the live task was dispatched. The gate worked, but a cheap syntax/import preflight could have caught it before a full cross-platform CI run.

Inefficiency:

- Again, a bespoke built-in profile was required to express a generic lifecycle that should be plan data.

What should be better:

- Controller plans need first-class ephemeral files, generated-test execution, output assertions, context receipts, and automatic cleanup ledger semantics.

## Cross-cutting findings

### 1. Deterministic operations should not be delegated to a coding model

Compiler discovery, process stream/exit capture, protocol fixtures, context hashing, file materialization, test execution, cleanup, Git auditing, and publication reconciliation are control-plane responsibilities or deterministic adapters.

### 2. The next bottleneck is bespoke built-in profiles

The built-in diagnostics proved the right trust boundary, but `one new source module/profile per experiment` is not the desired product interface. A general bounded controller plan must make those operations composable as data.

### 3. Baseline authority must remain local while supporting self-hosting

A task must never grant an arbitrary Git ref. Local configuration maps semantic channels such as testing/production to authorized refs. PATCH-POLLER resolves and persists an immutable exact SHA at run creation.

### 4. Runtime self-update must be transactional

A testing revision must not replace the current daemon merely because a branch moved. The candidate runtime must pass cheap syntax/import checks plus configured doctor/tests in isolation. Activation failure leaves the previous runtime running and records evidence.

### 5. Context identity should be automatic

Every terminal context should include a digest receipt for the exact input context/task revision it consumed. Nonce echo tests should be unnecessary except when testing corruption/transport itself.

### 6. Ephemeral lifecycle should be automatic

PATCH-POLLER should maintain a cleanup ledger for every temporary path it creates/materializes and clean it in `finally` semantics. Terminal evidence should include created/removed/leftover counts and any cleanup failure.

### 7. No-op tasks should not publish useless branches

Diagnostic runs with no project change repeatedly pushed task branches whose head equaled baseline. Default behavior should publish status/evidence but elide branch creation/push when there is no candidate diff. A specific publication test may locally opt into forcing no-op publication.

### 8. Long-running work needs liveness without comment spam

Coalesced status should expose stage, elapsed time, last observed output/activity, and deadline/timeout so `working` can be distinguished from `hung` while preserving GitHub API discipline.

### 9. Cheap preflight should precede broad CI

Examples: `node --check`/module import for changed JS, JSON/schema parse, targeted Node tests, CMake configure for CMake changes. Full Windows/Ubuntu CI remains authoritative but should not be the first detector of trivial syntax errors.

## Required next features

See `specs/PP-013-controller-plans.md` for normative detail. Priority order:

### P0

1. Controller-plan + bounded file-bundle protocol.
2. Local authorized baseline-by-channel resolution with immutable resolved SHA.
3. Transactional runtime candidate activation/rollback.
4. Deterministic/no-model execution as the default; coding-model adapters disabled by default.

### P1

5. Local toolchain registry/resolver with named operations.
6. Managed scratch transaction + cleanup ledger.
7. Automatic context receipt/digest.
8. No-op publication elision.
9. Generic local-only fault injection.
10. PATCH-POLLER-owned capability doctor.

### P2

11. Sparse/coalesced long-run liveness reporting.
12. Faster locally configured testing-channel polling while preserving rate limits/reserves.
13. Cheap targeted preflight before full CI/runtime activation.

## Next-phase constraint

The implementation campaign for the above features is intentionally **chat-only plus PATCH-POLLER**. The primary ChatGPT controller authors code/spec/test changes. PATCH-POLLER performs deterministic materialization, local tool execution, testing, recovery, validation, sealing, and publication. Do not invoke Codex, Spark, or another coding model during this campaign unless the user explicitly changes this constraint or a future test specifically targets a model adapter.
