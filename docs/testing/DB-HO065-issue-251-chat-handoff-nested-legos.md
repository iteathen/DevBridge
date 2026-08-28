# DB-HO065: chat-handoff nested LEGO internals

Date: 2026-08-28

Issue: #251

Status: implemented and accepted on exact hosted Windows/Ubuntu qualification. This document authorizes no setup, elevation, service, provider, image, environment, VM, guest, repository-execution, remote projection, or publication effect.

## Assessment

`src/context/chat-handoff.js` is the stable parent for one bounded controller-recovery domain, but its 395 lines currently combine two different change axes:

- immutable protocol value behavior: closed-schema validation, normalization, canonical JSON, SHA-256 identity, resume seed parsing, and resume reconciliation; and
- durable-generation behavior: stored-record validation, current/previous pointer validation, planned/ready publication, compare-and-swap sequencing, fallback, and retention.

The public exports and `ChatHandoffStore` are already the correct parent studs. Callers import only that parent. The problem is internal ownership: a change to retention or pointer recovery currently requires editing the same implementation unit that defines the immutable digest, while a value-schema change shares code and context with persistence topology.

The extraction must preserve the exact external and durable contracts:

- `devbridge/chat-handoff-v1`, `devbridge/chat-handoff-store-v1`, and `devbridge/chat-handoff-pointer-v1`;
- canonical key sorting, set-like collection sorting, UTF-8 byte ceiling, and whole-value SHA-256;
- existing normalized field order, diagnostics, resume strings, and reconciliation result shapes;
- planned write -> planned readback -> ready write -> ready readback -> pointer write -> pointer readback ordering;
- current/previous fallback, monotonic sequence, previous-digest compare-and-swap, exact-current idempotence, and bounded retention; and
- the existing `StateStore`-shaped public constructor contract without teaching nested children about its concrete JSON/file implementation.

The current focused parent/integration baseline passes 19/19. The existing `JsonStateStore` serializes local writes through an in-process write chain and atomically replaces its one control file, but the handoff parent must continue to verify every dependent record/pointer readback rather than infer durability from adapter internals.

## Primary-source research

- Node documents that `Buffer.byteLength(text, 'utf8')` returns encoded byte length rather than JavaScript string length. The configured ceiling must therefore remain over the exact canonical UTF-8 serialization: <https://nodejs.org/api/buffer.html#static-method-bufferbytelengthstring-encoding>.
- Node documents that `hash.update(text, 'utf8')` consumes the specified string encoding and `hash.digest('hex')` returns the final digest string. The immutable identity owner must preserve the existing SHA-256 over the exact canonical text bytes: <https://nodejs.org/api/crypto.html#hashupdatedata-inputencoding>, <https://nodejs.org/api/crypto.html#hashdigestencoding>.
- ECMAScript specifies `JSON.stringify` through `SerializeJSONProperty`/`SerializeJSONObject`, which enumerates the selected keys in the produced object. DevBridge's stronger deterministic contract comes from recursively constructing a fresh object with lexically sorted keys before stringification; extraction must not replace that mechanism with incidental caller insertion order: <https://tc39.es/ecma262/multipage/structured-data.html#sec-json.stringify>, <https://tc39.es/ecma262/multipage/structured-data.html#sec-serializejsonobject>.

## Reassessment

A single generic persistence framework would broaden this change beyond the handoff domain and risk creating a second effect journal, which DB-014 explicitly forbids. Allowing stored-record or pointer children to import the value child would also make a private topology permanent. The smallest complete design keeps one parent facade and composes sibling-independent nested owners through neutral function ports.

1. A **value contract** owns closed semantic validation, normalization, canonicalization, digest identity, bounded construction, resume seed values, and observation reconciliation. It knows no key, record, pointer, retention, or persistence topology.
2. A **record contract** owns only the planned/ready envelope and exact payload/digest verification. Semantic validity and digest computation arrive through neutral normalization ports supplied by the parent.
3. A **pointer contract** owns only the current/previous value, deterministic local key derivation, and pointer-field validation. It cannot read, write, remove, or rank durable entries.
4. A **retention policy** receives neutral entry summaries plus protected keys and returns removable keys. It cannot mutate storage or revise record/pointer identity.
5. A **store transaction** sequences neutral read/write/list/remove ports with build/digest/record/pointer/seed operations. It cannot redefine value validity or know the concrete state-store adapter.
6. The parent alone constructs this topology, preserves all public exports, validates the caller-facing store contract, and adapts concrete `get`/`set`/`entries`/optional `delete` methods to neutral persistence operations.

The resume behavior remains with the immutable value owner because it is pure closed data transformation and reconciliation, not durable topology. The parent continues to export the established function names; these are stable studs, not legacy routes.

## Scoped plan

1. Freeze representative normalized JSON, digest, resume strings, error/result shapes, record/pointer shapes, store operation order, and fallback/history behavior with direct tests.
2. Extract the value, record, pointer, retention, and store-transaction owners. Nested children import no sibling or local implementation and receive only neutral local ports.
3. Reduce `src/context/chat-handoff.js` to the sole public facade/composition root. Delete moved implementation from the parent; add no compatibility implementation or alternate store path.
4. Add a topology gate proving only the parent imports nested children and that children name no JSON-file adapter, GitHub, repository controller, model, provider, platform, VM, or other external topology.
5. Run direct value/digest, record, pointer, retention, transaction-order, corruption, compare-and-swap, size, resume, mailbox, projection, and app tests, including repeated failure/recovery runs.
6. Register the new source/tests in repository preflight, then run preflight, the complete suite, `git diff --check`, and exact hosted Windows/Ubuntu CI.
7. Close #251 only after hosted CI passes the exact implementation commit, and update parent #244 with the qualification evidence.

## No-elevation boundary

Through at least 2026-08-31 this work is software-only. It must not invoke Hyper-V, install or activate a service/provider/image/environment, start/stop/create/remove a physical VM, run a guest operation, request UAC, retry elevation, or attempt an elevation bypass. Remote handoff projection and product publication are also outside this structural slice; only branch commits/pushes and hosted CI are permitted.

## Implementation checkpoint

`src/context/chat-handoff.js` remains the only public surface and is now a 109-line validation/composition facade around five sibling-independent nested owners:

- the immutable value owner retains the exact v1 schema, normalized field/list order, recursive canonicalization, UTF-8 ceiling, SHA-256 identity, resume seed, and resume reconciliation;
- the record owner retains the exact planned/ready v1 envelope and verifies payload identity through neutral normalization/digest ports;
- the pointer owner retains the exact current/previous v1 value and deterministic local key derivation without persistence access;
- the retention owner ranks only neutral key/order summaries and returns removals without mutating state; and
- the transaction owner sequences neutral read/write/list/remove plus value/record/pointer operations without knowing the concrete state adapter or semantic payload fields.

Only the parent imports and connects these children. Children import no sibling or local implementation. The persistence-side children name no repository, GitHub, Codex, model, provider, platform, VM, remote-agent, or concrete `StateStore` topology. The parent alone maps exact repository/semantic fields to neutral subject/order/identity ports and preserves the established caller-facing diagnostics.

Moved code was deleted from the parent; no legacy parser, compatibility record, alternate pointer, or second store path remains. The three durable protocol identifiers and planned -> readback -> ready -> readback -> pointer -> readback ordering are unchanged.

Local qualification on 2026-08-28:

- direct nested-owner plus retained parent/mailbox/projection/app tests: 24/24 passed;
- 50 varied valid values matched the pre-extraction normalizer, canonical bytes, SHA-256 digest, and resume seed exactly;
- the frozen representative value retained digest `33e360374592f4a01c7ead2d1137319837456bba6c3582d7d3fa6662fa9134ab` and 1,055 canonical UTF-8 bytes;
- ten repeated value/store/recovery runs passed 15/15 per iteration;
- repository preflight passed 168 directly checked syntax files, 2 JSON files, and 138 targeted test files; the targeted nested test imports and verifies all five child files;
- the complete suite passed 1,718 total / 1,703 passed / 15 expected Windows/platform skips / zero failures; and
- topology gates and `git diff --check` passed.

No UAC request, elevation attempt/bypass, protected operation, physical provider/VM/image/environment/guest action, repository execution, remote handoff projection, or product publication occurred. Commit and push this exact checkpoint, then require hosted Windows/Ubuntu qualification before closing #251.

## Hosted preflight reassessment

CI run `33219166402` attempt 1 on exact implementation commit `d4e2e892ca6e3bef0f3cd971936d40c9e2c5bff8` passed Windows serialized full-suite/doctor and both Ubuntu jobs, but Windows cheap preflight reached its fixed one-minute job boundary without emitting a product/test failure. A failed-job-only rerun reproduced the same Windows preflight timeout while the already-qualified jobs remained green. This is another exact instance of open CI resource-budget issue #290, not evidence that the handoff contract failed.

The five new children had been added both as individual `node --check` subprocesses and as imports of the new targeted nested contract. On Windows the extra sequential process launches duplicated syntax coverage and pushed the bounded job over its wall-clock budget. Remove only those five redundant direct syntax registrations: the already registered parent imports every child, and the targeted nested test imports/reads every exact child and proves its topology. Keep the new targeted test, all complete-suite coverage, and the one-minute CI limit unchanged. Local corrected preflight passes 168 direct syntax files + 2 JSON files + 138 targeted tests in 38.28 seconds. Requalify the correction on exact hosted Windows/Ubuntu CI before acceptance.

## Accepted hosted qualification

GitHub Actions run `33219513699` qualified exact correction commit `fb4d2650921e7e17fb9821988c74e061e64a1224` across all four Windows/Ubuntu jobs. Windows bounded preflight/identity/installer passed with the unchanged one-minute cheap-preflight budget; the preflight step completed in 43 seconds. Ubuntu complete-suite/doctor and bounded preflight also passed.

The first Windows complete-suite attempt passed 1,709 tests and hit the already documented #290 20-second child-process boundary only in `Windows Hyper-V construction reconciles only the exact default-adapter New-VM partial effect`. That exact test had passed on implementation commit `d4e2e892ca6e3bef0f3cd971936d40c9e2c5bff8`, and the failed-job-only rerun on the correction commit passed the complete 1,718-test serialized suite plus doctor in 2 minutes 27 seconds. No product timeout, test timeout, safety assertion, or hosted deadline was widened. The bounded preflight correction is accepted; #290 continues to own the independent hosted-runner timing recurrence.

No UAC request, elevation attempt/bypass, protected operation, physical provider/VM/image/environment/guest action, repository execution, remote handoff projection, or product publication occurred during qualification.
