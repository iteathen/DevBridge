# DB-HO061: nested run-coordinator LEGO internals

Date: 2026-08-28

Issue: #247

Status: implementation complete locally; hosted qualification remains pending. This document authorizes no setup, elevation, service, provider, image, VM, guest, or repository-execution effect.

## Assessment

`RunCoordinator` is the correct caller-facing and authority-bearing parent, but its 895-line implementation directly contains several independently changing mechanics:

- bounded output and Git/context projections;
- durable transient-retry timing;
- trusted-feedback provenance, cursor, decision, and continuation-window interpretation;
- candidate rejection and baseline/local-candidate reverification calculations;
- deterministic replay-window decisions; and
- final-candidate identity and publication-disposition calculations.

The same file must remain the only owner of authoritative `state.stage` changes, save ordering, status publication, workspace preparation/validation/sealing, controller-plan and model invocation, exact publication effects, lease-fence handling, and terminal acceptance. Splitting those responsibilities into peer coordinators would weaken the DB-005 durable-run contract and make recovery ordering ambiguous.

The existing tests prove the important whole-run behavior: exact revision serialization; resumable preparing/running/verifying/publishing states; trusted exact-content feedback; bounded transient retries; candidate rejection repair; baseline rebase/reverification; local post-verification drift; deterministic replay limits; no-op publication; exact-head publication; and lease-loss fencing. The restructure must keep those parent tests unchanged except where additional direct boundary evidence is added.

## Primary-source research

Node.js 22.16 documents that timer callbacks are invoked after the requested delay as the event loop permits and makes no guarantee about exact timing or ordering. Therefore the durable retry contract must continue to persist an absolute `notBefore` instant and re-evaluate it with the injected clock; a timer firing is not authoritative evidence that the deadline elapsed: <https://nodejs.org/download/release/v22.16.0/docs/api/timers.html#settimeoutcallback-delay-args>.

This structural issue adds no external effect and does not change Git, provider, process, filesystem, or hypervisor behavior. Existing DB-007, DB-014, DB-016, DB-017, DB-019, and DB-020 contracts are sufficient for the remaining ownership decisions.

## Reassessment

One child per coordinator method would create file geometry without stable ownership. Extracting workspace or publication effects would instead create a competing run authority. The smallest coherent decomposition is:

1. A **projection owner** produces bounded output, Git, and provenance values. It receives the current source label and timestamp as data and contains no current upstream identity.
2. A **retry-window owner** validates absolute deadlines, performs only the injected wait, and calculates the fixed exponential retry record. It neither persists nor changes a run stage.
3. A **feedback-continuation owner** converts a bounded poll result into an idle, cancel, or continue decision plus bounded provenance/decision/cursor/window values. It cannot save, publish, or choose a stage.
4. A **candidate-recovery owner** calculates rejection, baseline-reverification, baseline-checkpoint, local-drift, and deterministic-attempt outcomes from neutral values. It cannot observe a workspace, persist state, publish status, or choose an accepted stage.
5. A **finalization-policy owner** compares verified and observed candidate identity, decides whether publication is unnecessary or required, and builds the completion projection. It cannot seal or publish a candidate and cannot declare completion.

Only `RunCoordinator` imports and composes these children. Children import no sibling and name no reporter, workspace implementation, tool, provider, repository, controller, model, platform, or remote service. Current durable field names and values remain unchanged; there is no compatibility wrapper, alternate run record, legacy parser, or parallel state machine.

## Scoped plan

1. Extract the projection helpers and pass concrete durable provenance labels from the parent composition.
2. Extract retry waiting/scheduling while preserving the exact 5-second base, 60-second cap, absolute persisted `notBefore`, malformed-deadline failure, attempt accounting, and injected clock/sleep behavior.
3. Extract feedback interpretation while preserving rejected-entry bounds, provenance retry semantics, cursor behavior, accepted exact-content decisions, cancellation, continuation-window extension, and retry clearing.
4. Extract recovery calculations while the parent retains snapshot observation, all `state.stage` writes, every save/status publication, and recursive deterministic replay.
5. Extract finalization identity/disposition/result calculations while the parent retains seal and exact publication effects, intent persistence, and terminal acceptance.
6. Delete the moved code from the parent. Add direct child tests plus a source boundary proving children cannot set a stage or invoke persistence, status, workspace, seal, publication, process, plan, or tool topology.
7. Run focused coordinator/retry/feedback/baseline/publication/lease tests, repeated recovery tests, repository preflight, the complete local suite, `git diff --check`, and exact hosted Windows/Ubuntu CI before closing #247.

## Acceptance boundary

This is behavior-preserving structural work. It does not establish provider readiness, image readiness, profile provisioning, guest transport, repository execution, or the physical Windows/Linux C canary. During the operator's three-day no-UAC interval it performs no protected operation and requests no elevation.

## Implementation checkpoint

`RunCoordinator` remains the sole public and authority-bearing owner. It is the only nested composition point and the only source that assigns `state.stage`, persists the run, publishes status, invokes a tool or bounded plan, observes/prepares/validates/seals a workspace, performs exact publication, handles lease loss, or declares terminal acceptance. Its source is now 805 lines rather than 895 while intentionally retaining the thin authoritative state-machine ordering.

The nested owners are:

- `projections.js`: bounded output plus exact candidate/content-evidence projections;
- `retry-window.js`: fixed 5-second-to-60-second exponential records, absolute deadline validation, and injected waiting;
- `feedback-continuation.js`: bounded rejected/accepted provenance, cursor, cancel/continue decision, and continuation-window interpretation;
- `candidate-recovery.js`: bounded history, attempt-window, and local identity-drift calculations; and
- `finalization-policy.js`: candidate identity comparison, no-diff/publish disposition, and terminal result projection.

Only the parent imports these members. Every child is import-free, imports no sibling, uses neutral local inputs, and contains no run-stage assignment or persistence, reporter, workspace, execution, seal, publication-effect, controller, model, provider, platform, or remote-service topology. Current concrete provenance labels remain only at the parent composition edge. Moved code was deleted from the parent; there is no compatibility wrapper, alternate run record, legacy parser, or competing coordinator.

Existing durable run fields and exact strings remain intact. A new parent failure test additionally proves that malformed persisted retry time fails as a policy error before any workspace or process effect.

## Local evidence

- focused child, coordinator, candidate, baseline, feedback, deterministic-plan, decision-gate, lease, and retry suite: 46 passed, 0 failed;
- ten additional coordinator recovery/retry repetitions: passed;
- repository preflight: 140 syntax files, 2 JSON files, and 134 targeted test files passed;
- complete repository suite: 1,694 total, 1,679 passed, 15 expected platform skips, 0 failed;
- nested authority/topology source gate: passed; and
- `git diff --check`: passed.

Hosted Windows and Ubuntu qualification on the exact pushed implementation commit remains required before #247 closes. No setup, elevation, service, provider, image, environment, VM, guest, or repository-execution effect occurred.

## Accepted evidence

GitHub Actions run `33212636105` qualified exact implementation commit `9cf4155df5887d8df1120dbf13b43a110ab7c420`:

- Windows serialized complete suite plus doctor passed in 2 minutes 18 seconds;
- Ubuntu complete suite plus doctor passed in 41 seconds;
- Ubuntu preflight, identity audit, and installer regression passed in 23 seconds; and
- unchanged attempt 2 passed Windows preflight, identity audit, and installer regression in 1 minute 7 seconds.

Attempt 1's Windows smoke preflight failed the existing real CMake capability probe under parallel targeted-test load, while that same test passed in the serialized Windows complete suite on the same SHA. The unchanged retry passed. This does not invalidate the isolated coordinator implementation, but it proves that #290's full-suite-only serialization did not finish its broader Windows smoke reliability acceptance. Issue #290 was reopened with the exact failure and rerun evidence; no product or probe timeout was widened.

This accepts issue #247. It does not accept provider, image, profile-environment, guest-transport, repository-execution, or physical C-canary readiness. No UAC or protected operation occurred.
