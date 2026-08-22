# Reconstructable environment lifecycle

Issue #170 establishes the source-of-truth contract used by the lifecycle program in #169. Issue #172 adds diagnosis and bounded in-place repair without changing the durable authority model.

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
- #173 reuses the same construction stages for missing/invalid system-storage `rebuild`.
- #174/#175 add destructive `reset` and complete implementation `recreate` semantics.
- #176 exposes the lifecycle through operator CLI/setup/doctor/re-entry UX.
