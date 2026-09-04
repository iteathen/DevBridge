# DB-HO147 — issue #417 GitHub Release destination

Date: 2026-09-04

Status: locally qualified candidate; hosted qualification pending

Coordinates with: #159, #178, #197, #200, #417, DB-003, DB-008, DB-009, DB-017, DB-019, and DB-HO124 through DB-HO146.

## Accepted predecessor and exact seam

DB-HO146 merged through PR #472 as exact Stage 8 head `579c14cb03961e0e6330f4279a768efb4f62e582`. Candidate run `33919880194` and fresh integrated run `33920356680` each passed all four Ubuntu/Windows smoke and full jobs, including doctor.

The accepted publication gate has transport-neutral destination ports for immutable-object ensure/read-back and authority ensure/read-back. No production adapter currently implements those ports. This slice adds only one GitHub Release destination adapter. GitHub remains one provider and one failure domain; this adapter cannot satisfy the independently controlled second-origin requirement and cannot authorize a real release by itself.

## Primary-source reassessment

GitHub's REST release-assets contract supplies the required narrow operations:

- one configured numeric release ID addresses the release without consulting a moving tag or latest-release selector;
- release assets are listed by that exact numeric release ID and carry numeric asset IDs, names, states, sizes, and optional SHA-256 digests;
- raw binary uploads use the release-specific upload endpoint and reject duplicate filenames with HTTP 422;
- raw reads use the numeric asset endpoint and may return either a direct HTTP 200 body or one HTTP 302 location; and
- an upstream upload failure can leave a zero-byte `starter` asset.

References:

- <https://docs.github.com/en/rest/releases/assets>
- <https://docs.github.com/en/rest/releases/releases>

The adapter therefore treats existing exact names as idempotent observations, verifies their metadata, and lets DB-HO145 stream/hash the bytes back. It never uses overwrite semantics, never deletes a conflicting or `starter` asset, never follows an origin-provided release/tag selector, and never treats GitHub's optional digest as a replacement for DB-HO145 read-back verification.

## LEGO contract

Add one provider-specific adapter that accepts only:

1. exact repository owner/name and exact numeric release ID;
2. a credential callback retained at the adapter boundary;
3. one caller-selected bounded HTTP duration; and
4. injected fetch/timeout ports for independent tests.

It exposes the already accepted destination shape:

```text
identity
objects.ensure(exact local chunk)
source.fetch(exact descriptor chunk) -> bounded byte stream
authority.ensure(exact named bytes)
authority.read(exact named identity) -> bounded bytes
```

Object assets use a digest-derived safe name. Authority assets use a digest of the authority name, keeping caller names out of URL construction while preserving a deterministic one-to-one mapping. Repository/release identity, API/upload hosts, authentication, pagination, and GitHub response normalization remain inside the adapter. The neutral gate, Ubuntu producer, setup, and #197 construction consumer learn none of them.

## Failure, recovery, and cleanup

- Validate options and request identities before network or file effects.
- Use exact asset metadata and reject duplicate names, changed size, changed optional digest, renamed assets, non-uploaded state, unexpected pagination, malformed JSON, transformed downloads, excess bytes, redirects outside approved GitHub asset storage, and unknown fields.
- Upload through a held direct regular file and re-observe its identity before and after the request.
- Use one request-bounded abort signal; add no retries, sleeps, polling, delete, replacement, release creation, or tag mutation.
- If GitHub reports an ambiguous failure or leaves a `starter` asset, stop. A later invocation re-observes that state rather than deleting it.
- Tests own and remove only their temporary files. No release, credential, setup, UAC, service, provider, VM, or installation effect occurs in this slice.

## Validation plan

1. Focused fake-fetch proof for exact asset naming, upload, existing-asset idempotency, numeric-ID read-back, direct 200 and validated 302 handling, pagination, cancellation, and file re-observation.
2. Fail-closed proof for duplicate/renamed/starter/mismatched assets, malformed or oversized responses, bad redirect hosts, transformed or wrong-length bytes, unknown fields, missing credentials, and mutation during upload.
3. Compose the adapter with `ImmutableReleasePublicationGate` and prove object verification precedes authority prerequisites and the authority commit remains last.
4. Run preflight, architecture/product/standalone gates, exact Node.js 22.16.0 full suite, doctor, cleanup, candidate all-four CI, exact integration, and fresh integrated all-four CI.

This candidate will not publish a real capsule. Real publication still requires a locally authorized production signing key, an exact release destination, an independently controlled second production origin, and offline media. #197 consumption and physical construction remain later separately authorized gates.

## Implemented boundary and local evidence

`GitHubReleaseDestination` implements the provider adapter without adding a release creator, tag selector, asset overwrite/delete path, retry loop, or broad GitHub client. It derives collision-separated object and authority asset names from exact digests, enumerates the exact numeric release through bounded 100-item pagination, holds and re-observes each direct object file across upload, verifies uploaded/existing asset metadata, and returns exact download streams to DB-HO145. A documented HTTP 302 asset response may cross exactly once to HTTPS `githubusercontent.com` release storage; the credential is not forwarded, another redirect is refused, and both declared and observed byte counts remain exact.

The initial focused run exposed that a 999 ms duration was accepted. The constructor boundary was corrected to the existing project minimum of 1,000 ms; no test or timeout was weakened. Exact Node.js 22.16.0 qualification used one single-link 85,119,640-byte runtime at SHA-256 `c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19` and passed:

- GitHub destination plus neutral publication-gate proof: 14/14;
- repository-execution architecture gates: 34 total / 33 passed / one expected Windows symlink skip;
- product identity and standalone launcher: 3/3;
- bounded repository preflight: 3 standalone artifacts / 289 syntax files / 2 JSON files / 229 dependency-selected tests;
- complete serialized suite: 2,293 total / 2,271 passed / 22 expected skips / zero failures or cancellations in 347.902 seconds; and
- example-configuration doctor: exit zero and `ok: true`, with repository execution truthfully unavailable because the example has no persistent-environment route.

Cleanup revalidated the exact qualification path directly under the local non-OneDrive Temp directory, found zero external process references, removed the runtime and TAP log (2 files / 85,666,170 bytes), and verified that the qualification root and every attributable `db-github-release-*` test root were absent. The retained installation, package cache, release evidence, and VMs were untouched.
