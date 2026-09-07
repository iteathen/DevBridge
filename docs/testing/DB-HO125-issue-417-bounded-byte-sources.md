# DB-HO125 — issue #417 bounded byte sources

Date: 2026-09-02

Status: adapters implemented and locally qualified; hosted acceptance pending

Coordinates with: #159, #178, #197, #290, #328, #392, #417, DB-003, DB-008, DB-009, DB-019, DB-020, DB-HO124.

## Accepted predecessor and scope

DB-HO124 candidate `6ce89a005f7074d99f1badc81af91962d7724789` passed all four pull-request jobs in run `33608267927` and rebase-merged as exact Stage 8 head `ab331d69170e18fd9bfcc70627fbdad210381a47`. Candidate and merge have identical tree `981dcd1dfd9e82e3eaa74a5ed68b012cb5bd3f00`. Fresh Stage 8 run `33608636460` attempt 2 passed all four jobs. Attempt 1 independently reproduced two pre-existing hosted-Windows PowerShell child stalls at their fixed 60-second test ceilings; #328 and #392 were reopened under #290 without changing a timeout.

This next #417 slice adds only concrete byte-source adapters under the accepted immutable-object acquisition port. It does not select or sign a release, name a package, alter first-byte execution, publish an artifact, wire setup, construct an image, or change a production/test timeout.

## LEGO shape and authority

- One HTTPS source instance owns one exact locally configured content-addressed base URL and one explicitly configured whole-transfer duration. Two instances with different base URLs are independent sources without creating two implementations.
- The request URL appends only the descriptor-authorized chunk SHA-256. Subject, logical object name, transport filename, remote redirects, response URLs, and response headers cannot select a path or artifact.
- HTTPS requests require status 200, exact `Content-Length`, identity encoding, no range response, and a streaming body. Redirect mode is `error`. The neutral acquisition child independently rechecks exact length, chunk digest, and whole-object digest before publication.
- One filesystem source receives an existing real directory and reads only the digest leaf. It creates, repairs, deletes, or renames nothing on offline/LAN/removable media. It holds and re-observes one non-symbolic, single-link regular file while streaming.
- A source failure disables that replica for the rest of the current acquisition transaction. Later explicit acquisition/restart may re-observe it; no hidden retry loop or new backoff clock is introduced in this slice.

This preserves the hierarchy: release authority chooses the exact descriptor and source composition; adapters expose bytes; acquisition verifies and caches; consumers retain their existing artifact-specific authority.

The accepted `HttpsFileDownload` was reassessed but not reused as this port. It owns caller-selected destination files, resumable range state, redirect allowlists, and whole-file retry policy. Adapting it beneath the immutable acquisition child would create a second temporary-file/cache layer and let two components contend for destination ownership. The byte-source adapters instead stop at an asynchronous body, leaving all temporary-file, chunk, journal, and cache publication authority in `ImmutableObjectAcquisition`.

## Timeout decision

The HTTPS adapter has no implicit duration default. Composition must provide a positive bounded `maxDurationMs`, and the adapter applies it across response acquisition and body iteration while also honoring caller cancellation. This avoids an aging magic default and leaves later first-byte/package compositions responsible for evidence-backed values appropriate to their own fixed object sizes. No existing timeout is altered.

Node.js 22.16.0 documents `AbortSignal.timeout(delay)` and `AbortSignal.any(signals)` in its globals contract: <https://nodejs.org/download/release/v22.16.0/docs/api/globals.html>. The Fetch Standard defines redirect mode `error` as returning a network error for a redirect response: <https://fetch.spec.whatwg.org/#concept-request-redirect-mode>. The adapter also races response acquisition and each body-iterator step against the composed signal so the bound does not depend only on an injected fetch implementation honoring cancellation.

## Test-first evidence plan

The initial tests must fail while the adapters are absent. They then require:

1. digest-only HTTPS URL construction, explicit duration use, identity encoding, and redirect rejection;
2. rejection of status, range, encoding, missing/incorrect length, and ambiguous base URL policy;
3. duration cancellation during body iteration;
4. exact failover between two independently configured HTTPS sources with one call to the down replica across a multi-chunk transaction;
5. digest-only read-only filesystem delivery with missing/size/hard-link rejection;
6. blank-cache completion from offline bytes while HTTPS is denied; and
7. source-adapter topology scans that exclude release, package, provider, and installation identity.

The implemented focused immutable-object plus existing image-artifact family passes 54/54. It includes source-specific duration failover without converting that event into caller cancellation, malformed iterator failover before destination state opens, corrupt same-size offline bytes failing before cache publication, and transaction-local replica quarantine. A local cache write/sync/open failure remains outside the source-failure marker and therefore cannot be hidden by trying another origin.

Official exact-minimum Node.js 22.16.0 passes the same focused 54/54 set, repository preflight at two standalone artifacts / 257 syntax files / two JSON files / 207 dependency-selected tests, and the combined hosted-equivalent architecture/product/standalone selection at 37 total / 36 passed / one expected Windows symlink skip. The final complete serialized suite passes 2,168 total / 2,147 passed / 21 expected skips / zero failures / zero cancellations in 331.290 seconds. Exact doctor exits zero with GitHub admission and native C/CMake/CTest available while repository execution remains truthfully unavailable because the persistent environment is not yet constructed. Diff hygiene passes. Across initial and final exact-runtime qualification plus the earlier focused work window, cleanup removed all 217 validated targets containing 18,275 files / 322,652,231 bytes, including both checked Node runtime copies and TAP evidence; final matching-root and attributable-process counts are zero.

## Next boundary

After hosted acceptance, connect the same verified source composition to the deliberately small first-byte artifact and its exact signed identity. Offline bundle indexing/signature binding, DevBridge source bundle production, Ubuntu binary/source capsule production, publication, and construction consumption remain later #417 owners.
