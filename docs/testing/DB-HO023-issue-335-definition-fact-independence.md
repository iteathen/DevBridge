# DB-HO023 — issue #335 definition-fact independence

Status: implemented, hosted-qualified, and squash-integrated into `cuda-target` by PR #336 at `c3214285489128dda0a00ea7de3ffa191ae6aa24`. The exact reviewed branch head was `7218488b5ae5c699b153219125fd6a728384df71`, based on `a398ab4abc79dce2dca4a0ed2ab0727bfa3f9533`.

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

## Implementation

The generic observation normalizer now treats `stored`, `current`, and `persistent` strictly as independent booleans. No ordering, platform, identifier, or topology relationship is inferred between them. The reconciliation loop is otherwise unchanged: it invokes only missing fact owners in dependency order, requires exact successful action evidence, re-observes after each action, and rejects any change outside the fact owned by that action.

The boundary suite now enumerates all eight initial fact combinations and proves exact convergence. Dedicated cases prove an already-persistent upgrade skips persistence mutation and a loaded-but-missing recovery skips refresh mutation. Existing interruption, no-op, malformed/widened contract, invalid action evidence, and neighbor-change tests remain intact.

DB-HO022's live prose was corrected in place so the repository does not retain the superseded false invariant as current guidance.

## Local qualification

- focused definition boundary: 8 passed, 0 failed;
- repository preflight: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 43`);
- repository-execution architecture gates: 34 total, 33 passed, 1 expected Windows symlink-capability skip, 0 failed;
- full suite: 1,251 total, 1,240 passed, 11 expected platform skips, 0 failed, with a normal TAP exit in 52.9 seconds.

No elevation prompt or real account, service, provider, VM, or protected-host mutation occurred.

## Hosted qualification and integration

Exact reviewed head `7218488b5ae5c699b153219125fd6a728384df71` passed all four jobs in GitHub Actions run `33130806998`:

- Ubuntu smoke — passed in 14 seconds;
- Ubuntu architecture gates, full suite, and doctor — passed in 31 seconds;
- Windows smoke — passed in 49 seconds;
- Windows architecture gates, full suite, and doctor — passed in 1 minute 54 seconds.

PR #336 was squash-integrated into `cuda-target` at `c3214285489128dda0a00ea7de3ffa191ae6aa24`. Local tree-equivalence verification between the exact reviewed head and integration commit passed before cleanup.

This closes issue #335 and restores the correct neutral foundation for Linux lifecycle composition. It does not itself claim Linux service, elevated setup, provider, or VM readiness.
