# DB-HO027 — issue #346 exact Linux refresh mechanics

Status: implemented, qualified, and integrated from exact `cuda-target` baseline `e0380852f138f50b0e0dd95d7903a5e44a127964` through isolated PR #347. Reviewed head `56692dfc110d472e814bc1d440ad37305c46fe3f` was squash-integrated as `47b88b025fce1dee923406ba6892438fc5646eb8`; both resolve to tree `928c2c709fa9804e1ffb79e9d85cfade004d1d26`.

## Assessment

The shared protected-authority reconciler already owns the durable stage, verify, quiesce, promote, start, health, restore, checkpoint, and pending-effect recovery sequence. Linux has independently qualified lower bricks for protected records, immutable numeric identity, generation staging, restart-safe historical generation verification, volatile endpoint topology, exact unit definition, fixed service actions, and broad read-only inspection.

The missing owner is the atomic Linux mechanic contract that fits those lower effects into the shared reconciler. Without it, an interrupted unit update cannot be distinguished from foreign drift, a retained generation cannot be selected safely for restoration, and active/staged/retained state cannot be reconciled against the actual configured and running generation.

The current broad inspector remains candidate-oriented and is intentionally not the mechanic. It is useful for final readiness, but using it as the transition engine would make service, generation, identity, and endpoint topology permanent internal dependencies of one component.

## Primary research

Current systemd primary documentation confirms the transition boundaries already selected by the lower adapters:

- enabling a unit and starting a unit are orthogonal; enable establishes boot-time links and does not itself start the service;
- `daemon-reload` reloads unit files and rebuilds the manager dependency tree;
- `start` activates a unit and `stop` deactivates it;
- `--no-ask-password` suppresses interactive authorization prompts for programmatic actions;
- `Type=exec` makes unit start fail when systemd cannot execute the configured program or establish the configured user, but it is not application health evidence.

Primary sources:

- [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)
- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

These findings preserve separate definition refresh, persistence, activation, and health evidence. The mechanic must not collapse them into one successful command result.

## Reassessment and selected boundary

Add one self-contained Linux mechanic owner with a closed local contract. It imports no storage, generation, protected-tree, system-manager, endpoint, service-observation, plan, provider, or health implementation. Its ports are neutral temporary connections:

- `journal`: durable shared transaction load/save;
- `transition`: a bounded projection of the currently pending local transition, not the foreign journal object;
- `state`: load/save of bound active, staged, and retained generation identities;
- `subjects`: exact declared-subject observation, candidate staging, and read-only verification;
- `preparation`: exact local pre-activation readiness;
- `definition`: exact selected-generation definition establishment;
- `activity`: configured/running generation observation plus exact quiesce/activate actions;
- `probe`: bounded selected-generation health.

The component returns the existing neutral refresh-mechanics shape. A later setup composition may temporarily map concrete Linux bricks into these ports; their names, protocols, paths, service identity, and provider topology never enter the mechanic's state or output.

Durable `state` remains authoritative. Actual definition/process evidence must agree with it in stable state. A mismatch is admitted only while `transition` proves the exact pending promote or restore subject and the activity is stopped. This permits observe-before-replay recovery when definition publication completed but the ownership update did not. Promotion/restoration establish preparation and definition first and save the durable generation state last.

No cleanup port exists. Missing, damaged, extra, or unverifiable declared subjects block rather than granting recursive deletion or automatic collision replacement.

## Plan

1. Define strict normalizers for generation identities, bounded state, declared subject presence, pending transition projection, configured/running activity, effect results, and bounded health evidence.
2. Implement stable and journaled-transition installation observation. Reject unbound state, missing declared subjects, absent active configuration, running/configured disagreement, unjournaled known-generation mismatch, and widened evidence.
3. Implement candidate-only staging and exact read-only verification.
4. Implement exact quiesce and activation with pre/post observation.
5. Implement promotion: verify staged candidate, establish preparation, establish exact definition while admitting only the prior definition, then persist active/staged/retained state last.
6. Implement restoration: verify retained target, quiesce the failed subject when necessary, establish the retained definition while admitting only failed bytes, then persist state last and retain the failed generation.
7. Implement health: require exact subject verification, durable active ownership, exact configured/running process generation, and bounded probe success.
8. Prove fresh install, exact-current no-op, stale refresh, failed-health rollback, all effect/checkpoint interruption frontiers, mismatch rejection, neutral interface closure, and end-to-end use through the shared reconciler.
9. Add focused qualification to preflight; run Linux-related tests, architecture gates, the full suite, doctor, and isolated Ubuntu/Windows CI.

## Explicitly deferred

This issue does not create or migrate the protected authority state directory, invoke elevation, attach setup, authorize libvirt, inspect or mutate qcow2, run a VM, cut over the production client, or claim Linux readiness. Those remain later #293 gates and continue to fail closed.

## Implementation

- `linux-lifecycle-authority-refresh-mechanics.js` is a self-contained atomic mechanic owner with no imports. It exposes only the existing shared mechanic functions and consumes closed neutral ports for journal, transition, state, subjects, preparation, definition, activity, and health.
- Durable state is normalized as one immutable binding plus active, staged, and bounded retained generation identities. Declared subjects must be present and the subject catalog must report exactness before state is treated as owned.
- Stable configured/process evidence must match the durable active generation. A stopped definition mismatch is admitted only for an exact pending promote or restore projection bound to the current candidate and exact prior subject.
- Staging is candidate-only, verifies materialized bytes before persisting staged state, and rejects retained-capacity exhaustion before materialization or quiesce.
- Quiesce and activation are exact and idempotent through pre/post observation. No command, path, service, endpoint, process-manager, or provider identity is representable in the mechanic contract.
- Promotion verifies the staged subject, establishes preparation, establishes only the candidate definition while admitting the exact prior definition, re-observes it stopped, and writes active/staged/retained durable state last.
- Restoration verifies the retained subject, quiesces only the failed exact subject when necessary, establishes only the retained definition while admitting failed bytes, re-observes it stopped, writes durable state last, and retains the failed generation.
- Health requires exact subject verification, durable active ownership, exact configured and running process generation, and bounded local probe evidence.
- Repository preflight now syntax-checks the mechanic and runs its focused suite.

## Shared recovery defect found and repaired

The new restoration-interruption test exposed a defect in the existing platform-neutral reconciler. Candidate rejection reason was not durable until after restoration completed. If restore changed the active subject but its result/checkpoint was lost, restart could checkpoint the restore and then fall back into the normal candidate path, attempting to stage the already rejected candidate again. A transiently improved candidate could also be accepted before the pending rejection recovery resumed.

The shared owner now saves `candidate-verification` or `candidate-health` intent before any rejection effect, gives that durable intent precedence over exact-current acceptance, reconciles any pending quiesce/restore/start effect by observation, and completes rejection recovery without restaging. The repair is platform-neutral and retains no Linux identity. Focused Windows refresh/service tests prove the existing Windows adapter remains compatible.

## Local qualification

All commands ran without elevation, UAC, service-manager mutation, provider mutation, or VM effects.

- New Linux mechanics plus shared reconciliation/adapter: 27 passed, 0 failed.
- Shared/Linux/Windows refresh and Windows service compatibility selection: 49 passed, 0 failed.
- Related Linux lifecycle and shared refresh selection: 137 total, 134 passed, 3 expected non-Linux filesystem skips, 0 failed.
- Repository preflight: 49 syntax files, 2 JSON files, 49 targeted tests, passed.
- Repository-execution architecture gate: 34 total, 33 passed, 1 expected Windows symlink skip, 0 failed.
- Full suite: 1,302 total, 1,291 passed, 11 expected platform/host skips, 0 failed.
- `doctor` against `config/devbridge.example.json`: exited successfully and continued to report repository execution unavailable/fail-closed because no persistent-environment route is configured.

## Remote qualification and integration evidence

PR #347 (`security/346-linux-refresh-mechanics` -> `cuda-target`) ran CI workflow `33136443109` against reviewed head `56692dfc110d472e814bc1d440ad37305c46fe3f`:

- Ubuntu smoke passed in 19 seconds.
- Ubuntu architecture gates, full suite, and doctor passed in 34 seconds.
- Windows smoke passed in 53 seconds.
- Windows architecture gates, full suite, and doctor passed in 1 minute 48 seconds.

GitHub reported every required job successful before integration. The pull request was cleanly squash-merged at `47b88b025fce1dee923406ba6892438fc5646eb8`. Exact reviewed/integrated tree equality was re-observed locally as `928c2c709fa9804e1ffb79e9d85cfade004d1d26`; no unreviewed content entered the integration commit.

Hosted qualification proves contract, recovery, and cross-platform compatibility behavior only. It is not physical systemd, libvirt, KVM, or qcow2 evidence.
