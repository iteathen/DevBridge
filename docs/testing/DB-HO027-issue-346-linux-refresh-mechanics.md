# DB-HO027 — issue #346 exact Linux refresh mechanics

Status: planned from exact `cuda-target` baseline `e0380852f138f50b0e0dd95d7903a5e44a127964` on isolated branch `security/346-linux-refresh-mechanics`.

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
