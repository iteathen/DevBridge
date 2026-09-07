# DB-HO142 — issue #417 bounded Ubuntu snapshot archive source

Date: 2026-09-04

Status: accepted

Coordinates with: #197, #417, DB-003, DB-008, DB-009, DB-019, DB-HO124 through DB-HO131, and DB-HO141.

## Accepted predecessor and scope

DB-HO141 merged through PR #467 as exact Stage 8 head `fabb2d2b65bec6272a9098835f1defbfc060c760`. Candidate run `33901908349` and fresh integrated run `33902273270` each passed all four Ubuntu/Windows smoke/full jobs. The accepted capture LEGO consumes an injected archive-reader port; it deliberately owns no concrete host, URL, timeout, retry, setup, or provider behavior.

This slice adds only one concrete bounded HTTPS adapter beneath that port. It does not select a release or snapshot, solve a package transaction, sign or publish a capsule, wire setup/construction, alter liveness policy, retry an origin, or touch a VM.

## Research and reassessment

Canonical documents the snapshot ID as an exact UTC `YYYYMMDDTHHMMSSZ` value and shows the resulting archive shape as `https://snapshot.ubuntu.com/ubuntu/<snapshot>/...`: <https://ubuntu.com/server/docs/how-to/software/snapshot-service/>.

Node.js 22.16.0 documents stable `fetch`, `AbortSignal.timeout(delay)`, and `AbortSignal.any(signals)`: <https://nodejs.org/download/release/v22.16.0/docs/api/globals.html>.

The adapter therefore receives one locally selected HTTPS archive base, exact snapshot, and explicit total read duration. The capture child supplies only a validated archive-relative path plus its object-specific maximum and, once signed metadata is available, the exact expected size/SHA-256. No response URL, redirect, header, remote timestamp, or local clock can change the selected snapshot or object.

## LEGO contract

`UbuntuSnapshotArchiveHttpsSource`:

1. validates a credential-free, query-free HTTPS base URL with a trailing slash;
2. appends one exact snapshot ID and one traversal-safe archive-relative path;
3. uses redirect mode `error`, identity encoding, and a composed caller/duration cancellation signal;
4. requires status 200, no redirect/range/transformation, and one positive declared content length;
5. rejects declared or streamed bytes beyond the capture-supplied object bound;
6. rechecks exact size/SHA-256 when signed index authority supplied it; and
7. returns bytes only.

It has no hidden retry or fallback. Release composition may instantiate another independently configured source after an explicit failed attempt, but origin availability cannot select another snapshot or relax identity. Published-capsule replication remains the mechanism that removes this live service from installation/construction.

## Test and acceptance plan

- exact URL construction, fixed snapshot, redirect denial, identity encoding, and explicit duration;
- constructor/request rejection before transport for ambiguous URLs, mutable snapshots, traversal, incomplete identity, or widened bounds;
- response rejection for status, range, encoding, missing/oversized length, byte-count drift, and digest substitution;
- bounded cancellation even when an injected fetch ignores its signal;
- capture-chain proof that every archive request carries an object-specific maximum;
- release-LEGO source scan excluding setup/provider/current-origin identities;
- focused chain, bounded preflight, architecture/product/standalone gates, complete suite, doctor, diff hygiene, candidate four-job CI, exact merge, and fresh integrated four-job CI.

No physical retry follows this slice. The next release-owned step is one thin producer composition that combines explicit release policy, exact DB-HO131 solution, this adapter, DB-HO141 capture, GPG verification, and DB-HO130 sealing, then verifies independently published replicas before exposing a signed release pointer. The separate #197 consumer follows only after that production evidence is accepted.

## Local qualification

Exact Windows evidence on 2026-09-04:

- focused source/capture/solver/sealer/authority chain: 34 total, 33 passed, one expected Linux-only skip, zero failed;
- bounded repository preflight: 3 standalone artifacts, 279 syntax files, 2 JSON files, and 221 dependency-selected tests passed;
- repository-execution architecture gate: 34 total, 33 passed, one expected Windows symlink skip, zero failed;
- product identity 1/1 and standalone installer regression 2/2 passed;
- complete suite: 2,261 total, 2,239 passed, 22 expected skips, zero failed or cancelled in 80.136 seconds;
- example-configuration doctor exited zero with `ok: true` and truthfully reported repository execution unavailable because that example supplies no persistent-environment route; and
- no physical setup, UAC, service, PATH, provider, or VM action occurred.

## Hosted acceptance

PR #468 qualified candidate `4d9fb5ec0c96ceb897662ec3435b08ca8991da78`; CI run `33903510501` passed Ubuntu smoke/full and Windows smoke/full+doctor. It rebase-merged as exact Stage 8 head `6362f61bcca30ce66738eab87299fd372708a3a5`. Fresh integrated run `33903915561` passed Ubuntu smoke in 36 seconds, Ubuntu full in 1 minute 1 second, Windows smoke in 3 minutes 21 seconds, and Windows full plus doctor in 4 minutes 22 seconds.

The source adapter is accepted. It does not authorize a physical retry. DB-HO143 owns the next thin release-production composition.
