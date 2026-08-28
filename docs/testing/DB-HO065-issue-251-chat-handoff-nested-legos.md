# DB-HO065: chat-handoff nested LEGO internals

Date: 2026-08-28

Issue: #251

Status: assessed, researched, and planned; implementation pending. This document authorizes no setup, elevation, service, provider, image, environment, VM, guest, repository-execution, remote projection, or publication effect.

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
