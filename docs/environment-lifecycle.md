# Reconstructable environment lifecycle

Issue #170 establishes the source-of-truth contract used by the lifecycle program in #169. Issue #172 adds diagnosis and bounded in-place repair without changing the durable authority model. Issue #173 adds rebuild for missing or invalid replaceable system storage by reusing the shared construction pipeline. Issue #174 adds explicit profile-wide reset with exact data-loss impact and local destructive authorization.

## LEGO boundary

The lifecycle core owns only neutral local concepts:

- a stable logical environment identity;
- a versioned desired declaration;
- a bounded neutral observation of the current materialization;
- reconstructability classification;
- diagnosis into one supported lifecycle action;
- a restartable lifecycle journal.

It does **not** own virtualization implementation names, storage paths, command lines, network object names, guest filesystem paths, repository implementation objects, or transport/source mechanics. Those details terminate at their owning adapters. Composition temporarily wires lifecycle contracts to those adapters.

## Durable authority

A declaration binds the locally approved execution profile to:

- guest family and generation;
- immutable image identity and generation;
- resource requirements;
- a neutral boot requirement;
- a neutral network requirement;
- bootstrap/tooling generation and requirements;
- a neutral enrollment/trust requirement;
- neutral workspace identities plus opaque host-authority identities used for reseeding;
- protected state classes, if any.

Boot and enrollment are explicit declaration authority rather than provisioning defaults. Construction adapters may map those requirement identities onto their local mechanisms, but the declaration does not name provider firmware objects, credentials, key files, or guest paths.

The logical environment identity is derived from the approved profile and does not change when image, resources, guest materialization, or implementation generation changes. Declaration replacement is compare-and-swap revisioned so stale setup/recovery work cannot silently overwrite newer local authority.

The local image location is deliberately absent from the declaration. #178 owns availability of the exact semantic image identity when a local cache is missing or corrupt.

## Observed state

Observation is evidence, not authority. It separately reports:

- materialization never-created, present, missing, unavailable, or ambiguous;
- system storage unknown, absent, present, or invalid;
- attachment readiness;
- enrollment state;
- bootstrap/tooling state;
- guest health;
- incomplete or ambiguous transition state;
- the declaration revision used as the observation basis;
- the current implementation generation when one is actually observed.

The declaration revision makes stale observations explicit rather than allowing old evidence to authorize a new declaration. Diagnosis combines this observation with bounded local resource/network/workspace/ownership evidence; it never promotes stale guest output or provider naming into authority.

## Diagnosis

Diagnosis is read-only. It produces a bounded result containing state, cause, whether the defect is repairable in place, the supported next lifecycle action, a path-free explanation, and neutral impact classes.

Important decisions include:

- `system-storage-missing -> rebuild`;
- `system-storage-invalid -> rebuild`;
- missing provider materialization -> `recreate` unless a future provider contract explicitly proves preservation-safe reconstruction around intact storage;
- invalid attachment with exact valid storage -> `repair`;
- stale/missing enrollment -> `repair`;
- bootstrap/tooling degradation -> `repair`;
- network/workspace degradation -> `repair` where exact authority is retained;
- stopped/paused/saved exact materialization -> `start`, not `repair`;
- provider/resource unavailability -> `provider-action-required`;
- incomplete/ambiguous ownership or stale observation -> `manual-review` or setup re-entry.

A recommendation is not mutation authority. `doctor` may project the diagnosis contract through a read-only list stud and must not repair an environment merely because it observed a repairable condition.

## Bounded repair

`repair` preserves the current logical environment, declaration, system-storage baseline, and implementation generation. It is not a weaker spelling of rebuild/reset/recreate.

The repair lifecycle uses the same journal and exclusive logical fence as construction:

`intent -> pre-observation -> fenced-attempt -> post-observation -> verification -> cleanup-reconciliation -> terminal`

The pre-observation records the exact diagnosed cause. Immediately before correction, repair re-observes authoritative state and refuses to stretch the operation to a changed cause. The correction port is allowlisted to preservation-safe/idempotent actions only. Current composition supports exact transition reconciliation, network reconciliation, exact attachment reconciliation, enrollment/bootstrap reconciliation, and workspace/guest readiness reconciliation.

Missing/invalid system storage, missing provider implementation, ambiguous ownership, resource admission failure, or any cause whose supported next action is not `repair` is rejected before the correction stud is invoked.

If a correction effect succeeds but its response is lost, restart does not blindly replay it. The resumed repair re-observes state; if the environment is already healthy it advances the existing journal without repeating the effect. An in-place repair may not change implementation generation.

## Rebuild

`rebuild` preserves the logical environment and declaration while replacing the implementation generation whose system storage is missing or invalid. It consumes the same #171 construction stages rather than owning a second provisioning stack.

Rebuild authorization has an explicit evidence order:

1. the exact current provider implementation must still be identifiable;
2. ownership of that exact implementation must be proven independently;
3. only after ownership is proven may `system-storage-missing` or `system-storage-invalid` authorize replacement;
4. if the implementation must be quiesced, ownership is re-proven after quiescence before replacement continues.

Provider-local `reason` text is descriptive health evidence only. A storage-health reason such as “system storage missing” cannot substitute for ownership proof and cannot mask `owned=false`. Missing or ambiguous ownership fails closed before any storage-health evidence can authorize destructive recovery.

After the ownership gate, rebuild resolves the exact approved image through #178, runs/resumes the shared construction pipeline for a new implementation generation, re-establishes guest/bootstrap/enrollment state, reseeds registered workspaces from host authority, and independently re-verifies readiness. The old system disk is not required to exist.

The outer lifecycle/rebuild request identity is the idempotency subject for ambiguous effects. A restart reconciles the same planned replacement generation rather than allocating another generation. Damaged or invalid superseded state is retained by default; cleanup may remove only exact owned state after separate safe-cleanup evidence permits it. Provider-specific health prose never broadens cleanup authority.

## Reset

`reset` is an explicit profile-wide destructive transition back to the exact declared clean baseline. It is not diagnosis-driven repair and it is not permission to target a single repository workspace while silently affecting sibling workspaces.

`planReset` is read-only. Its deterministic impact binds at least:

- logical environment identity and declaration revision;
- exact current implementation generation and current storage/transition state;
- exact target image and bootstrap generations;
- every affected registered workspace identity and count;
- preserved and discarded state classes;
- protected-state blockers;
- provider/image/resource/network/workspace prerequisites;
- whether the implementation generation changes;
- the rollback contract;
- one content-derived authorization subject.

A blocked preview is still useful: protected state, missing/ambiguous implementation, non-clear transition state, or unavailable resource prerequisites are reported in the impact rather than hidden by the preview path. Execution then fails closed until those blockers are resolved.

Reset has no default destructive authority. The execution path requires an injected local authorization contract to verify an opaque operator approval receipt against the exact impact subject, declaration revision, and current implementation generation. The receipt is not persisted in the lifecycle journal. Remote issue text, model output, repository content, guest output, or an arbitrary string cannot become reset authority merely by reaching the generic lifecycle code.

After authorization, reset records the exact impact subject in the lifecycle journal, acquires the normal exclusive fence, and re-observes the impact immediately before mutation. If the current generation has not changed, any material impact drift invalidates the approval before construction. If a replacement effect already happened but its response was lost, the outer reset delegates reconciliation to the request-bound replacement owner instead of inventing another generation or requiring a second approval.

The persistent-environment owner exposes staged replacement for this path:

1. create/reconcile one replacement generation under the outer lifecycle operation identity;
2. switch the logical environment's current implementation generation while retaining the exact superseded generation;
3. run the shared construction stages through preparation, workspace reseed, and readiness verification;
4. independently verify the final generation;
5. only then retire the exact retained history generation;
6. reconcile exact retirement if its response is lost.

Retirement accepts only an exact superseded history identity belonging to the still-current logical environment. Foreign/unowned state, a non-history identity, a running superseded generation, or changed attachment authority fails closed before provider deletion. Historical direct reset behavior remains separate compatibility behavior; the #174 profile-reset path uses staged replacement so old state is not retired before the new clean baseline is verified.

Workspace-local reset remains a separate narrower lifecycle contract. A workspace route/reset cannot authorize profile reset, and profile reset enumerates all sibling workspace identities before mutation.

## Mutable-state taxonomy

Lifecycle planning uses five neutral classes:

1. `authority` — host-owned configuration needed for reconstruction;
2. `materialization` — replaceable current implementation state;
3. `reseedable` — source that can be restored from host authority;
4. `disposable` — rebuildable caches, dependencies, generated outputs, and scratch;
5. `protected` — explicitly registered state that another bounded owner must handle before destructive lifecycle work.

A guest system disk is never treated as the sole authority needed to reconstruct an environment.

## Journal

Every mutation advances contiguously through:

`intent -> pre-observation -> fenced-attempt -> post-observation -> verification -> cleanup-reconciliation -> terminal`

The journal records only neutral identities, bounded subject identities, neutral observations, implementation generations, fence identity, outcome, and time. It stores no raw provider output, secrets, or paths.

An interrupted nonterminal record remains visible as active state. Later construction/recovery code must observe and reconcile that exact stage rather than blindly replaying an external effect.

## Reconstructability

The core exposes four explicit states:

- `fully-reconstructable`;
- `reconstructable-after-local-discovery`;
- `setup-reentry-required`;
- `ambiguous-or-unowned`.

The classifier never promotes unverified or ambiguous ownership into destructive authority. Legacy/incomplete state requiring additional decisions remains outside mutation until setup/re-entry supplies the missing local authority.

## Next slices

- #178 makes the exact declared image reconstructably available.
- #171 owns the shared restartable construction pipeline and `create`.
- #172 owns diagnosis and bounded in-place `repair`.
- #173 reuses the same construction stages for missing/invalid system-storage `rebuild` with ownership proven before storage-health evidence.
- #174 owns explicit profile-wide clean-baseline `reset` with exact local destructive authorization and post-verification retirement.
- #175 adds complete provider-instance `recreate` semantics using the same staged replacement/construction direction where applicable.
- #176 exposes the lifecycle through operator CLI/setup/doctor/re-entry UX.
