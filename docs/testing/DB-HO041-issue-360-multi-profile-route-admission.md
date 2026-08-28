# DB-HO041 — issue #360 multi-profile route admission

Status: assessed, researched against repository primary contracts, reassessed, and planned from exact predecessor `f84272155e0d910d76a39488e1412f97cff1034c` on `stage8/362-protected-activity-channel`.

## Assessment

The dual-guest acceptance requires one repository subject to have both Linux and Windows workspace routes. The activity-policy contract permits this only when exactly one route is locally preferred. Construction currently appends every route with `preferred: false`; the first route works only because it is unique, while adding a second makes normal execution ambiguous.

The failure is deeper than selection. Workspace construction verifies roots by asking the router for the subject's preferred target. If a preferred route is introduced while admitting another profile, construction can exercise the already-admitted profile and then publish the unverified new profile route. That would turn verification of one brick into authority for another brick.

This is an application-owned route-admission defect. It does not require a provider, guest, credential, setup UI, controller, repository, or Git change.

## Primary-contract research

- DB-020 and `docs/vm-stage6-repository-execution.md` require repository/profile pairs to own distinct isolated workspace routes, allow multiple profiles only with one preferred route, and require admission verification before policy publication.
- `docs/vm-lego-studs.md` requires profile and workspace selection to remain at the topology edge without leaking provider objects into generic execution.
- `normalizeEnvironmentActivityPolicy` enforces at most one preferred route per subject but deliberately does not invent one.
- `createExecutionProfileRouting` derives an exact target from subject plus profile and rejects ambiguous subject-only selection.

No unstable external platform behavior is involved, so no web/platform research can change this internal contract.

## Reassessment

Route admission must preserve two independent facts:

1. subject-only normal execution retains one stable local preferred route as topology expands;
2. construction verifies the exact route being admitted, regardless of which route normal execution prefers.

The smallest complete rule is first-admitted stability. A sole route is explicitly preferred. When a second route is added, the exact prior sole route remains or becomes preferred and the new route is not preferred. An already ambiguous multi-route policy is rejected rather than repaired by guessing. Construction derives the exact workspace target from the selected subject/profile pair and uses that target for health, transfer, and execution proof before publishing the changed policy.

## Dependency-ordered plan

1. Carry the exact derived workspace target beside each resolved local workspace entry.
2. Normalize preference only within the route-admission owner: make a sole route preferred, preserve one existing preferred route, and reject multi-route/no-preference ambiguity.
3. Verify health, put, and execute against each exact derived target rather than subject-only preferred lookup.
4. Publish only after every exact new/current target verifies.
5. Test first-route preference, second-profile stability, exact new-profile verification, ambiguous-policy refusal, failure-before-publication, and existing LEGO boundaries.
6. Run focused tests, repository preflight, and the complete suite; append exact evidence before commit.

No VM, network, service, image, credential, UAC, or remote task state is mutated by this work.

## Implementation checkpoint — 2026-08-28

`environment-construction-workspaces` now admits topology and verifies roots as separate local facts:

- each resolved workspace carries the exact deterministic subject/profile target derived by the existing routing owner;
- the first route for a subject is explicitly preferred;
- expanding a previously valid sole non-preferred route promotes that sole route before adding the second route, preserving first-admitted behavior;
- an already multi-route/no-preference policy is rejected rather than repaired by guessing;
- health, input transfer, and execution proof use the exact target being admitted, while the scoped channel independently maps it to the exact physical profile environment and workspace prefix;
- changed policy is still published only after every exact target verifies.

Verification:

- focused activity-policy, construction-workspace, profile-routing, stability, and Stage-6 LEGO suites: 21/21 passed;
- repository preflight: 99 syntax files, 2 JSON files, and 95 targeted tests passed;
- complete suite: 1,531 total, 1,516 passed, 15 platform-specific skips, and zero failures.

The active branch remains blocked from physical Linux activation only by the separately reported UAC transaction. This implementation created no provider or protected-authority effect.
