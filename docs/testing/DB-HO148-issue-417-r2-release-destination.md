# DB-HO148 — issue #417 R2 release destination

Date: 2026-09-05

Status: locally qualified candidate; hosted qualification pending

## Accepted seam and scope

PR #473 integrated as `98a8bab03ae92b64eeb7a5dc11b5e4ca5efa90e9`; integrated CI `33923223437` passed all four Windows/Ubuntu full and smoke jobs. DB-HO145 already owns descriptor-bound local admission, all-destination object verification, and authority-last publication. DB-HO147 implements its GitHub destination. The operator has now selected R2 and provided a bucket-only data credential, stored encrypted outside the repository. Real operator-side S3 write/read/delete and unauthenticated public read/range canaries passed and were removed. No other existing issue owns an R2 adapter.

## Research and design

- R2 S3 uses region `auto`, account-scoped HTTPS endpoints, and SigV4. Its object API supports conditional PUT; `If-None-Match: *` prevents overwriting an existing key.
- Keep SigV4 calculation in one pure child, qualified against AWS's published signature example. Keep account, bucket, credentials, concrete URL construction, response handling, and storage semantics in the R2 adapter. The neutral gate learns none of them.
- Use globally content-addressed chunk keys `objects/<sha256>` for deduplication and release-scoped authority keys `releases/<releaseId>/<name-sha256>` to avoid cross-release authority collisions. Only local composition selects the exact release ID and public origin.
- Expose the existing `objects.ensure`, `source.fetch`, `authority.ensure`, and `authority.read` ports. Credential callbacks are host-only; public GET requests are unauthenticated and forbid redirects/transformation.
- Validate all shapes before effects; hold and hash one direct single-link regular upload file and reobserve it before/after upload. An existing key must have matching exact length; the gate independently hashes its read-back. Conditional-write conflicts are reobserved, never overwritten or deleted.
- One explicit bounded operation signal covers credential acquisition, HTTP headers, and body consumption, including pending injected operations. No retry loop, sleep, administrative API, bucket creation, delete path, or secret-store access belongs in the adapter. Errors must not echo credentials or arbitrary provider response text.

References:

- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/s3/extensions/
- https://developers.cloudflare.com/r2/api/tokens/
- https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
- https://developers.cloudflare.com/r2/buckets/public-buckets/

## Qualification

Focused tests cover known SigV4 vectors, credentials confined to S3, exact key mapping, public reads, conditional conflicts/restart reconciliation, stable held-file checks, malformed inputs, changed/short/oversize/transformed responses, redirects, and cancellation of pending credentials/fetch/body reads. Compose with the existing publication gate to prove authority-last order and fail-closed replica verification. Then run preflight, architecture/product/standalone gates, exact Node 22 full suite and doctor, candidate all-four CI, exact integration and integrated CI, and a tiny live R2 adapter canary with exact owned cleanup.

This does not seal or publish a real release, activate installation trust, create/rebuild a VM, or claim GitHub Hello World success. R2's current r2.dev public endpoint is development-only and remains explicitly distinct from final production-hosting qualification. No credential value or operator-specific account/path enters repository code or fixtures.

## Implementation and local evidence

The R2 destination and pure SigV4 child now implement the existing publication ports without changing the neutral gate. Both AWS published signed-payload GET and PUT vectors match exactly. The 27 focused R2/GitHub/publication-gate tests pass on Node.js 22.16.0.

The first wider preflight caught a same-size upload-mutation case that metadata-only post-upload observation did not detect on Windows. The correction rehashes the held file after upload, retaining the existing identity/size/link/timestamp checks. It adds no delay or retry and does not weaken the assertion. The initial focused run also exposed stream destruction closing the held file before final observation; observation now precedes stream destruction. Focused tests after both corrections: 27 passed, zero failed/skipped, 218.465 ms. These are implementation findings, not physical installation evidence.

The operator's replacement data key independently passed encrypted disk round-trip, conditional S3 write, exact read-back, and owned-canary deletion/absence. Administrative read probes were denied. This establishes usable data access, not a full independent audit of the operator-declared bucket-only scope. No secret enters these source files or tests.

Repository preflight passes 3 standalone artifacts / 291 syntax files / 2 JSON files / 230 dependency-selected test files. Architecture/product/standalone qualification passes 37 total / 36 passed / one expected Windows symlink skip / zero failures in 5.311 seconds.

Complete serialized Node.js 22.16.0 suite: 2,306 total / 2,284 passed / 22 expected skips / zero failed or cancelled in 333.086 seconds. Example-configuration doctor exited zero with `ok: true` and GitHub CLI authentication available; repository execution is truthfully unavailable because the example has no persistent-environment routes. This is not evidence that the installed service can execute Hello World.

Cleanup matched 536 inactive temporary directories to their exact test fixture creators, including older attributable runs. Each resolved target was a direct child of the local Temp directory, without active process references, filesystem indirection, or disk/media files. Native PowerShell removal deleted all 536 roots / 23,632 files / 109,636,161 bytes and retained none from that set. Installation, VMs, active encrypted credentials, and recovery evidence were untouched. The final separate three-file qualification root (copied Node runtime, TAP log, one-use cleanup script) remains because the execution tool rejected its removal by policy; no alternate deletion mechanism or elevation was attempted. Its exact local path is retained in the operator checkpoint, not published as a machine-specific repository path.

Live development R2 qualification passed at `2026-09-05T03:05:54.348Z` through the implemented R2 adapter and unchanged neutral publication gate. Three explicitly synthetic public objects (76/69/67 bytes; 212 bytes total) were observed absent, conditionally uploaded (200), reobserved (200), and publicly read/hash-verified without credentials (200), in object -> prerequisite -> commit order. A second complete gate invocation performed zero additional PUTs and verified all three public objects again. A separate one-use operator cleanup verified exact bytes and ETags, conditionally deleted the three newly created canaries (204), and observed all absent (404). No real key/manifest/release was published. Non-secret intent and observation remain in the existing protected operator evidence directory; temporary helper and payload are removed.
