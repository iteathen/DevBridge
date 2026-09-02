# DB-HO124 — issue #417 immutable release-input foundation

Date: 2026-09-02

Status: first implementation slice locally qualified; neutral immutable-object descriptor, acquisition, durable progress, cache publication, and exact availability observation implemented; production origin and consumer integration deliberately absent

Coordinates with: #159, #178, #192, #197, #200, #417, DB-003, DB-008, DB-009, DB-011, DB-013, DB-019, DB-020, DB-HO005, and DB-HO123.

## Physical trigger

DB-HO123 merged as exact accepted Stage 8 head `3b8faed78b672a3265b465958b8dcb2361001778` after PR run `33600666030` and fresh Stage 8 run `33600994095` each passed all four Ubuntu/Windows full plus smoke jobs. The canonical non-OneDrive installation was bound to that exact head through the explicit install-only path, which emitted no elevation request and did not enter setup.

One freshly authorized ordinary `devbridge setup` then completed profile selection, protected-apply inspection, command installation, GitHub authentication/discovery, and prerequisites. It emitted no elevation-consent event and made no construction mutation. At elapsed 12 seconds, construction-authority failed closed because the exact `20260821T230000Z` `resolute/main` package index request to `snapshot.ubuntu.com` returned HTTP 502. No setup retry or moving-mirror substitution followed.

This is the availability boundary already owned by #417. It is not a recurrence of the Windows lifecycle handoff fixed by DB-HO123.

## Required research and reassessment

Canonical documents a snapshot ID as a UTC timestamp selecting the archive state at that time and requires continued use of that same snapshot selection for later package operations: <https://ubuntu.com/server/docs/how-to/software/snapshot-service/>. Debian's `apt-secure(8)` documents the archive trust chain in which the signed Release file binds repository metadata and package indexes: <https://manpages.debian.org/testing/apt/apt-secure.8.en.html>. RFC 9110 defines byte ranges as optional request semantics and permits a server to ignore Range; representation and validator correctness remain necessary for continuation: <https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests>.

Therefore availability may change only where exact bytes come from. It may not select another snapshot, infer a current archive, trust a mirror manifest, or depend on every source implementing resumable HTTP ranges. Fixed descriptor-bound chunks are independently fetchable objects; concrete adapters may use ranges only when their own exact protocol proves them.

The #178 image artifact lifecycle already proves ordered chunk coverage, individual chunk digests, and a whole encoded-object digest. Its acquisition owner is intentionally coupled to image identity, codec reconstruction, image-library admission, capacity, and quarantine. Reusing that parent for packages would invert ownership; cloning its integrity rules would split authority. This slice extracts the exact object/chunk normalizer as a shared child used by the existing image manifest, while the new acquisition child owns only immutable byte objects and its own content-addressed cache.

## Nested LEGO design

### Immutable object-set value

`devbridge/immutable-object-set-v1` binds one safe exact subject to a bounded sorted set of logical objects. Each object binds a safe leaf name, positive exact byte count, SHA-256, and a bounded ordered chunk list. Each chunk binds contiguous ordinal, safe leaf name, exact offset, positive size, and SHA-256. Normalization rejects unknown fields, path-shaped names, duplicate object/chunk names, reordered ordinals, gaps, overlaps, incomplete coverage, unsafe integer accumulation, and inconsistent size claims for one digest.

Canonical serialization plus SHA-256 gives the complete descriptor identity. Object order does not change that identity. No origin, URL, repository, package, executable, provider, installation path, or release selector crosses this child.

The existing image manifest now delegates its encoded-object chunk validation to this same normalizer. Image identity, encoding, codec, publication, and provider-native admission remain in the #178 parent.

### Immutable object acquisition

The acquisition child receives only a local control-owned cache directory, one normalized descriptor, an ordered bounded list of injected byte-source ports, and an optional cancellation signal. A source receives the exact immutable subject/object/chunk value and may return only an asynchronous byte body. It cannot return a replacement descriptor, digest, path, executable, redirect policy, or publication decision.

For each object, the child:

1. re-observes the exact content-addressed cache object;
2. re-observes and reuses only exact verified chunks for the same object digest;
3. tries injected sources in local composition order for a missing chunk;
4. enforces the exact chunk byte bound while streaming and verifies its SHA-256 before admission;
5. assembles all verified chunks into one owned temporary object and verifies the whole size/SHA-256;
6. atomically publishes only to the digest-named cache location;
7. re-verifies committed bytes; and
8. removes redundant verified chunks through exact file-by-file cleanup, with no recursive broad target.

Every source may fail before bytes, between chunks, after returning the final byte, or by returning wrong/truncated/oversized bytes without changing the accepted object identity. If every source fails and no exact cache object exists, the child returns one typed `IMMUTABLE_OBJECT_UNAVAILABLE` result bound to subject, object, chunk, and attempt count. Previously committed objects remain untouched.

### Durable progress and observation

The descriptor-digest transaction journal records per-object transitions through `planned -> acquiring -> object-complete -> verified -> cache-committed`. Journal writes use owned temporary files, file sync, and atomic rename. Restart never trusts a terminal journal as completion: exact cache and chunk bytes are re-observed first. A missing committed object is reacquired; a substituted journal, unsafe file shape, content-addressed cache mismatch, or unexpected cleanup entry fails closed.

`observe()` is a separate read-only exact availability operation. It performs no source call and creates no directory or journal. Only complete size/SHA-matching cache objects report available.

One acquisition instance serializes its own operations. The future production composition must retain the existing singleton setup/construction transaction authority around any shared acquisition root; this neutral child does not invent a second cross-process lock or stale-lock recovery policy.

## SOLID, CUPID, KISS, authority, and timeout decisions

- **SOLID:** value normalization, byte acquisition/cache, concrete origin behavior, release selection/signing, package solving, and construction remain separate owners connected by narrow values and ports.
- **CUPID:** descriptor bytes are canonical and predictable; all accepted outputs are explicit immutable inputs to later consumers; interruption resumes from physically reverified chunks rather than opaque retry state.
- **KISS:** one object-set protocol, one acquisition owner, one content-addressed cache, one per-subject journal, and one typed unavailable result. There is no mirror voting, fastest-source authority, alternate snapshot, universal installer/package component, or new provider behavior.
- No production timeout is added, removed, widened, or shortened. Concrete source adapters continue to own bounded connection/header/body policy. The neutral child enforces deterministic count/size/digest/cancellation bounds and cannot invent network timing authority.

## Focused evidence

The tests were added before the implementation and initially failed because both new modules were absent. The completed focused set passes 40/40 across the new object-set/acquisition/LEGO tests and the existing image manifest/acquisition/bundle/fail-closed/capacity/LEGO tests.

New evidence covers deterministic descriptor identity, path/unknown-field rejection, coverage gaps/overlap/reordering, duplicate names, primary failure before a body, verified-chunk restart, failure after the final byte, wrong digest, short body, exact-cache source denial, redundant-chunk cleanup, all-sources-down typed failure with prior-cache preservation, journal completion re-observation, read-only availability, journal substitution, hard-linked journal rejection, unsafe cache shape, and absence of origin/package/provider/installation identity in the neutral children. Existing image behavior remains green through the shared normalizer.

Official exact-minimum Node.js 22.16.0 passes repository preflight at two standalone artifacts / 257 syntax files / two JSON files / 207 dependency-selected tests, the hosted-equivalent architecture gate at 34 total / 33 passed / one expected Windows symlink skip, product identity plus standalone launcher at 3/3, and the final complete serialized suite at 2,154 total / 2,133 passed / 21 expected skips / zero failures / zero cancellations in 326.936 seconds. Exact doctor exits zero with GitHub admission and native C/CMake/CTest available while repository execution remains truthfully unavailable because no persistent-environment route exists. Diff hygiene passes. Across the initial and post-review qualification passes, cleanup removed all 395 validated targets containing 25,774 files / 350,515,103 bytes, including both checked Node runtime copies and TAP evidence; final matching-root and attributable-process counts are zero.

## Slice boundary and next work

This first slice does not yet make the physical setup succeed. It intentionally adds no GitHub/HTTPS/filesystem/offline adapter, first-byte change, source bundle, Ubuntu package/source capsule, setup composition, image construction change, or release publication effect.

After complete local and hosted qualification accepts this foundation, continue #417 in dependency order: concrete bounded origin/offline adapters; exact first-byte/source integration; release-time Ubuntu binary and source capsule production with upstream signature/hash provenance; independent-origin publication verification; local capsule consumption by #197; and primary-denied plus offline-only physical construction. Do not retry setup until the production package-capsule consumer is accepted and bound.
