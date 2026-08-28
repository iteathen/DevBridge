# DB-HO023 — issue #335 definition-fact independence

Status: planned from exact `cuda-target` baseline `a398ab4abc79dce2dca4a0ed2ab0727bfa3f9533` on isolated branch `fix/335-definition-independent-facts`.

## Assessment

DB-HO022 introduced a platform-neutral reconciler for one exact stored, current, and persistent definition. While designing the first Linux lifecycle composition over that contract, a valid upgrade state exposed one false invariant: an existing stable service identifier can remain enabled for startup while the next target definition is neither stored nor loaded. Relative to the target, that state is `{ stored: false, current: false, persistent: true }`.

The current neutral owner rejects that state because it assumes persistence cannot exist without target bytes. This blocks safe upgrades before the admitted local adapter can publish the new exact bytes. It would force a higher module either to lie about persistence or to disable valid startup wiring merely to satisfy a generic internal assumption. Both violate the local contract and transient-topology design.

## Research and reassessment

The DB-HO022 primary systemd research already established that `enable` owns startup symlink wiring and does not start the service. That wiring is attached to the stable unit name, not to one content generation. Definition bytes, manager-loaded state, and startup persistence are therefore three independent target-relative facts.

Primary source:

- [systemd `systemctl` manual source](https://github.com/systemd/systemd/blob/main/man/systemctl.xml)

The neutral reconciler should not encode any platform relationship between those facts. Its effect ownership remains exact:

- `publish` may change only `stored` from false to true;
- `refresh` may change only `current` from false to true;
- `persist` may change only `persistent` from false to true.

Every other fact must be preserved and every effect must still be followed by exact observation. The local adapter—not this generic owner—must decide whether existing bytes, manager state, or stable wiring are admitted or foreign.

## Plan

1. Remove only the false cross-fact rejection from the generic observation normalizer.
2. Preserve strict booleans, closed schemas, action evidence, exact postconditions, bounded definition bytes, no-op behavior, and observation-based interruption recovery.
3. Prove convergence for all eight valid boolean combinations, including already-persistent upgrade and loaded-but-missing recovery states.
4. Retain the neighbor-change failure proof so each action can establish only its owned fact.
5. Correct DB-HO022's durable prose; do not retain the invalid invariant as historical live guidance.
6. Run focused tests, repository preflight, repository-execution architecture gates, and the full suite. Publish and qualify only the isolated fix branch before resuming Linux lifecycle composition.

No UAC, sudo, account/service/provider command, VM action, or physical host mutation belongs to this correction.
