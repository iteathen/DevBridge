# DB-HO066: setup-authority nested LEGO internals

Date: 2026-08-28

Issue: #252

Status: implemented and accepted on exact hosted Windows/Ubuntu qualification. This document authorizes no setup invocation, UAC/elevation request or bypass, service/provider/image/environment/VM/guest operation, repository execution, remote setup projection, or product publication.

## Assessment

`src/runtime/setup-authority.js` is the correct sole public authority surface, but its 445 lines combine six independently changing responsibilities:

- closed local scalar/entry values and invariants;
- snapshot creation, normalization, profile replacement, and entry replacement;
- blocker/readiness evaluation;
- accepted/working durable-record validation;
- sanitized template import/export; and
- mutable begin/edit/validate/commit/discard transaction sequencing.

The public exports, current callers, and durable values are already the correct parent studs. The extraction must preserve exactly:

- protocols `devbridge/setup-authority-snapshot-v1`, `devbridge/setup-authority-record-v1`, and `devbridge/setup-authority-template-v1`;
- the exported closed class/requirement/approval/availability/provenance/validation collections;
- strict unknown-field rejection, identifier/reference bounds, deterministic profile and class order, complete profile/class matrices, and current frozen result shape;
- imported-template sanitization and mandatory local revalidation;
- one accepted generation plus at most one working generation, exact operation identity, base-revision check, edit-invalidates-validation behavior, and current diagnostics; and
- the `SetupAuthorityManager` constructor and method surface consumed by profile, distribution-policy, and activation-policy setup composition.

The focused parent/state/caller baseline passes 24/24.

The audit also found a pre-existing concurrency defect which is not a safe hidden refactor change. Two independent managers against one setup-authority file returned different owned working generations in 49 of 50 concurrent trials; the remaining trial hit a same-process temporary-file-name collision and Windows `EPERM`. Issue #371 now owns installation-wide serialization/CAS and collision-proof publication. This structural issue will expose one bounded transaction child but preserve current single-owner semantics; it will neither claim nor simulate the future #371 guarantee.

## Primary-source research

- ECMAScript defines freezing through `SetIntegrityLevel`, which changes the target object's own property descriptors and does not recursively traverse referenced objects. The extraction must therefore continue explicitly freezing nested profile arrays, authority entries/arrays, template requirements, blockers, working records, and returned wrappers instead of assuming a frozen parent makes its children immutable: <https://tc39.es/ecma262/multipage/abstract-operations.html#sec-setintegritylevel>.
- Node documents `crypto.randomUUID()` as a cryptographically pseudorandom RFC 4122 version-4 UUID. The parent should retain that host-local default operation-identity source and inject it into the transaction child; no caller, imported template, remote value, or nested evaluator may choose the default source: <https://nodejs.org/api/crypto.html#cryptorandomuuidoptions>.
- ECMAScript `Await` resolves the supplied value through the Promise machinery and resumes the suspended async context on fulfillment/rejection. Preserving sequential `await load`, decision, and `await save` calls preserves current single-owner ordering, but it does not make a multi-call read/modify/write sequence atomic across manager/store instances. That distinction is why #371 remains a separate storage/coordination correction: <https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-await>.

## Reassessment

The ownership seams remain valid, but they should not become public services or a generic setup framework.

1. A **value contract** owns only bounded local primitives, authority-entry normalization, stable entry identity/order, default entries, and requirement-map validation.
2. A **snapshot contract** owns only complete immutable snapshot values plus profile/entry replacement. It receives primitive operations through neutral function ports and cannot evaluate or persist.
3. A **blocker evaluator** owns only the pure mapping from one normalized snapshot to frozen bounded blockers. It cannot approve, validate, save, or commit.
4. A **record contract** owns only the v1 accepted/working record shape and generation invariants. Snapshot/primitive validation arrives through neutral ports.
5. A **template contract** owns only the v1 sanitized requirement template and imported-provenance value. It cannot carry subjects, approval, availability, validation, accepted generation, or a persistence port.
6. A **transaction manager** owns current single-owner load/save ordering and begin/edit/validate/commit/discard mechanics. It receives normalization, mutation, and evaluation ports and cannot define schemas, templates, caller ownership prefixes, setup topology, or provider effects.
7. The parent alone creates that topology, retains every public export, supplies the local default clock/operation identity, and remains the only application-facing authority surface.

Every child is import-free and sibling-independent. Child studs use only intrinsic value/action vocabulary. Only the parent maps current protocols, closed sets, diagnostic context, and nested operations together. Moved logic is deleted from the parent; no compatibility parser, alternate record, secondary manager, or legacy path is retained.

## Scoped plan

1. Add a direct nested-contract test that freezes representative values, errors, blockers, templates, manager operation order, imported-template rejection, validation invalidation, revision acceptance, and discard behavior.
2. Extract value, snapshot, evaluation, record, template, and transaction children as complete responsibilities. Do not leave duplicate implementations in the parent.
3. Reduce `src/runtime/setup-authority.js` to constants, composition, and exact public re-exports; retain `src/state/setup-authority-state-store.js` as the concrete persistence adapter pending #371.
4. Strengthen topology tests so only the parent imports nested children, children import no local implementation/sibling, and no child names caller, provider, repository, remote-agent, VM, platform, product-policy, or concrete JSON-store topology.
5. Prove the exact existing profile/distribution/activation caller contracts, restart state, import/revalidation, accepted/working generations, failure paths, and repeated single-owner recovery.
6. Register only the targeted nested contract in cheap preflight. The already registered parent and targeted test import every child, avoiding redundant Windows process launches while preserving exact child coverage.
7. Run focused tests, repeated recovery tests, repository preflight, the complete suite, topology/diff checks, and exact hosted Windows/Ubuntu CI. Close #252 only after the exact implementation commit qualifies.

## No-elevation boundary

Through at least 2026-08-31 this work remains source/test/documentation-only. It must not invoke setup, request or retry UAC, attempt an elevation bypass, install/reconcile a service or prerequisite, mutate provider/image/environment/VM state, run a guest operation, execute repository code, or publish product configuration. Branch commits/pushes, issue updates, and hosted CI are permitted.

## Implementation checkpoint

`src/runtime/setup-authority.js` remains the only public surface and is now a 112-line constants/composition/re-export parent around six import-free nested owners:

- value primitives own bounded identifiers/references, closed choices, entry normalization, stable entry identity/order, defaults, and requirement maps;
- snapshots own complete immutable profile/class matrices and profile/entry replacement;
- evaluation maps a normalized value to ordered frozen blockers without mutation or acceptance;
- records own the exact accepted/working v1 generation value and its revision/timestamp/validation invariants;
- templates own sanitized requirement-only export and imported-provenance reconstruction; and
- the transaction manager owns the existing single-owner load/save sequence and begin/edit/validate/commit/discard mechanics through neutral function ports.

Only the parent imports and connects these children, supplies the default clock and cryptographic local operation identity, and exposes the established names. Children import no sibling or local implementation and name no caller, repository, remote-agent, provider, platform, VM, product-policy, or concrete JSON-store topology. Moved code was deleted from the parent; no compatibility schema, alternate record, second manager, or fallback path remains.

Behavioral and local qualification on 2026-08-28:

- public export names and callable arities match the pre-extraction parent;
- 50 varied snapshot/replacement/blocker/template/import cases match the pre-extraction implementation byte-for-byte under JSON serialization;
- direct child plus retained parent/state/profile/distribution/activation tests pass 30/30;
- ten repeated nested/value/transaction/restart runs pass;
- repository preflight passes 168 directly checked syntax files, 2 JSON files, and 139 targeted test files; the targeted nested test imports and verifies every child;
- the complete suite passes 1,724 total / 1,709 passed / 15 expected Windows/platform skips / zero failures; and
- topology gates and `git diff --check` pass.

The extraction intentionally does not claim concurrent multi-manager transaction safety. The independently reproduced lost-owner/temp-publication defect remains open as #371 and the concrete state adapter is unchanged.

No setup, UAC/elevation request or bypass, service/prerequisite reconciliation, protected provider/image/environment/VM/guest operation, repository execution, remote setup projection, or product publication occurred. Commit and push this exact checkpoint, then require hosted Windows/Ubuntu qualification before closing #252.

## Accepted hosted qualification

GitHub Actions run `33220876080` passed all four jobs on exact implementation commit `bd4754699a8d9855d771914cd3b9258c396b5671` on its first attempt:

- Windows serialized complete-suite plus doctor: 2 minutes 18 seconds;
- Windows bounded preflight, identity audit, and standalone-installer regression: 1 minute 24 seconds, with cheap preflight completing in 48 seconds under its unchanged one-minute step budget;
- Ubuntu complete-suite plus doctor: 42 seconds; and
- Ubuntu bounded preflight, identity audit, and standalone-installer regression: 24 seconds.

No product/test/CI timeout was widened. GitHub's Node-action deprecation annotations are workflow-maintenance warnings and did not affect qualification. Close #252; retain #371 as the independent setup-authority concurrency/durable-publication defect.
