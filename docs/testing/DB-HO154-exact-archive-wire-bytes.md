# DB-HO154 — exact archive object bytes over HTTPS

Date: 2026-09-05

Status: native failing-object proof and focused regression passed; complete qualification pending

## Assessment and authority

#480 is integrated as `6097240fa2a6d37418a0012ce1e495775d04edf2`, parent `1321a9a3c26714ac4fed09ce096a896e2002a438`, tree `28eb62110a182d8f8abc95a04ae599583b126e00`, exactly matching candidate `231949bc88e92d0f6c07972eca6e659cd53aa294`. Candidate CI33944710073 and fresh integrated CI33945098820 passed all four Windows/Ubuntu full/smoke jobs on attempt 1. #478/#479 are closed; #368 remains draft. This supersedes DB-HO152's pending status, not its historical evidence.

Real capture HO153 completed all 15 metadata objects and 546 selected binaries, then 146 source files. At 707 completed reads /1565068732 bytes /623160 ms it rejected `pool/main/l/linux/linux_7.0.0-30.30.diff.gz` because the server returned `Content-Encoding: gzip` despite `Accept-Encoding: identity`. The capture owner removed its partial root; absence was observed. No installation, UAC, VM, signing or publication occurred. #481 owns the new transport failure under #417 on #197's dependency path.

AGENTS, DB-003/008/009/019, the source/capture/sealing implementations and tests, and DB-HO142/152 were inspected before correction. The source adapter owns this concrete transport; capture owns selection/identity/bounds, and independent sealing owns its separate Canonical-chain checks. No overlapping implementation was found. Existing runtime immutable-object and publication adapters are not changed.

## Research and falsification

[RFC9110 sections 8.4 and 12.5.3](https://www.rfc-editor.org/rfc/rfc9110.html) distinguish representation content coding from media type and request negotiation. [Node22 HTTPS](https://nodejs.org/download/release/v22.16.0/docs/api/https.html), [HTTP](https://nodejs.org/download/release/v22.16.0/docs/api/http.html), and [Zlib](https://nodejs.org/download/release/v22.16.0/docs/api/zlib.html) provide a raw incoming stream and separate optional decoding. A default fetch client is unsuitable when automatic content decoding changes archive-object identity. The built-in raw HTTPS capability is sufficient; no additional dependency or transport framework is needed.

Native HEAD returned status200, content-type text/plain, content-encoding gzip, and content-length2015294. A bounded raw HTTPS GET returned exactly2015294 bytes/SHA256 `35f9f52942d6eca65b4734045482bb45c6616f06cc6faba75c96feebf58556cf`. Reacquiring resolute-updates/main/source/Sources.gz through the accepted exact reader with size234150/SHA256 `00cfd8f119b485a135bea7cd7f515ec480a6e6902547000a8193b38654206bf9` reproduced the linux7.0.0-30.30 signed metadata record authorizing those precise bytes. Its metadata identity is inherited from HO153's authenticated InRelease chain. The file exists intact: this is a representation capability gap, not evidence of archive corruption.

Two regressions failed on accepted6097240 before implementation: exact gzip-coded archive bytes were rejected, and the default transport used the decompressing fetch path instead of raw HTTPS.

## Scoped correction and explicit contract

The existing `UbuntuSnapshotArchiveHttpsSource` default uses built-in HTTPS without automatic decoding or redirects. Its injected `fetchImpl` response-shaped test port remains available, but body bytes are interpreted as archive-object bytes; injecting a decoding client cannot make changed bytes pass the exact digest. No new public option or provider registry is added.

Identity encoding remains requested. A single gzip coding is admitted only with complete preexisting exact size/SHA256 authority. Unknown/stacked coding and unpinned encoded InRelease remain rejected. Declared size, streamed maximum, final exact size and SHA256 remain mandatory. No decompression/recompression, filename exception, alternate origin, retry, snapshot movement, or bound increase is permitted. This refines DB-HO142's original blanket encoding rejection only for identity-pinned raw bytes; all integrity invariants remain.

An operation-owned cancellation controller finalizes the native request on success, header rejection, stream error, caller abort or deadline. Native request/response error listeners cover cancellation before body iteration. No active socket is intentionally left waiting for its deadline after admission already failed.

## Qualification, review and cleanup

Focused source/capture/producer/GPGV/sealer chain: 35/35 passed on Windows Node22.16.0. Coverage includes unchanged exact bytes, wrong digest, already-decoded bytes, unpinned/unknown/stacked encoding, raw default transport, redirect denial without following, truncated/oversized bodies, invalid length, cancellation, network error, cleanup, and retry after rejected response. The corrected actual default adapter then retrieved the real failing kernel patch with exact signed size/hash; bytes remained in memory only.

Next gates: local preflight, architecture/standalone/product checks, complete exact-head four-job CI and full-diff author review (not independent review), same-scope unprotected Stage8 integration and fresh post-integration CI. A new full capture must use a new exclusive intent/journal and must not replay terminal HO153. No physical install/construction follows without its own accepted-input and authority requirements.

Retain compact terminal journals and the four previously admitted public solver files. Failed capture data is already removed. Remove attributable test roots and completed operator scripts after their evidence is durable, preserve live/recovery/user state, and do not bypass the existing tool-policy block on removing the retained Node runtime directory. Hello World via GitHub and both VMs remains unproven.
