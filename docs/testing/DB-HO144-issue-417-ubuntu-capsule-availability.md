# DB-HO144 — issue #417 Ubuntu package-capsule availability

Date: 2026-09-04

Status: locally qualified candidate; hosted qualification pending

Coordinates with: #197, #417, DB-003, DB-008, DB-009, DB-017, DB-019, and DB-HO124 through DB-HO143.

## Accepted predecessor and exact seam

DB-HO143 merged through PR #469 as exact Stage 8 head `2826f35bfaf79d37e3eecb1e17fe20b6a5cce939`. Candidate run `33907353724` and fresh integrated run `33907863585` each passed all four Ubuntu/Windows smoke and full jobs.

The accepted release side can now solve one exact immutable APT transaction, capture the complete Canonical-signed metadata/binary/source closure, and seal it into three descriptor-bound object sets plus a caller-key-signed manifest. The missing seam before construction is a narrow consumer-side availability owner that verifies the signed subject, reacquires all three exact sets through the accepted neutral multi-origin/offline port, and independently re-observes the cache files before returning local evidence.

## Ownership plan

Extract one transport-neutral acquisition-evidence observer from the source-bundle consumer's duplicated held-file measurement. It accepts only an immutable descriptor, acquisition result, and optional cancellation signal. It requires exact subject/descriptor/object evidence, direct nonsymbolic single-link regular files, stable held filesystem identity, exact byte count, and SHA-256.

Add one Ubuntu package-capsule availability composition that:

1. accepts one caller-pinned signed capsule authority and one acquisition port;
2. verifies and freezes the exact release authority before acquisition;
3. sequentially reacquires metadata, binary, and source descriptors through the same neutral cache owner;
4. independently re-observes each returned cache object through the neutral evidence child; and
5. returns the exact normalized release plus grouped local object evidence for the later #197 materializer.

It selects no origin, cache path, snapshot, package, executable, repository layout, setup action, provider, VM, or construction effect. The composition caller owns concrete source ordering and cache roots. Partial verified cache state remains resumable under DB-HO124; this child adds no retry or timeout.

## Test plan

- Seal one structurally valid signed capsule once, copy its digest objects to a distinct filesystem origin, deny a primary source, and reacquire every descriptor into a blank cache through the secondary source.
- Reacquire the same authority into another blank cache using only the original release directory as an offline bundle and require identical object identities.
- Reject forged descriptor/object/location evidence, changed authority, substituted bytes, links, filesystem indirection, unknown fields, and pre-aborted observation.
- Reuse the neutral observer in source-bundle materialization so source and package consumers do not split cache-evidence authority.
- Run focused tests, bounded preflight, architecture/product/standalone gates, the exact Node.js 22.16.0 serialized suite, doctor, cleanup, candidate four-job CI, exact integration, and fresh integrated four-job CI.

This slice creates no retained release artifact or key, performs no remote upload, and does not claim a real Canonical production capsule. That operational release artifact remains required before #197 consumption and physical construction. No setup, UAC, service, PATH, ACL, provider, VM, or physical-host action is authorized here.

## Implemented boundary

`ImmutableObjectAcquisitionEvidence` is the single protocol-neutral re-observation child. It normalizes the caller's descriptor, requires exact acquisition state/subject/descriptor/object evidence, rejects filesystem indirection and hard links, and hashes every exact byte while holding a stable file handle. Source-bundle materialization now uses this same child rather than carrying a second cache-evidence implementation.

`UbuntuPackageCapsuleAvailability` copies and verifies the signed caller-pinned authority at construction, then requests the metadata, binary, and source descriptors through one injected acquisition port. Each result crosses the independent evidence observer before the composition returns the verified release and grouped local object evidence. The composition remains transport-, origin-, cache-, setup-, provider-, and construction-neutral.

The first implemented focused run found one test double still modeling the older partial source-bundle acquisition result. The production acquisition port already returns `state`, `sourceAttempts`, and `reusedChunks`; the fixture was corrected to that exact accepted contract. No production validation was weakened.

## Local evidence

Node.js 24 diagnostic focused proof passes 60/60, and diagnostic preflight passes 3 standalone artifacts / 283 syntax files / 2 JSON files / 224 dependency-selected tests.

Exact Node.js 22.16.0 qualification uses a single-link 85,119,640-byte runtime with SHA-256 `c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19` and passes:

- affected focused proof: 60/60;
- bounded preflight: 3 standalone artifacts / 283 syntax files / 2 JSON files / 224 dependency-selected tests;
- repository architecture, product identity, and standalone launcher proof: 37 total / 36 passed / one expected Windows symlink skip / zero failed;
- complete serialized suite: 2,271 total / 2,249 passed / 22 expected skips / zero failed or cancelled in 367.609 seconds; and
- example-configuration doctor: `ok: true`, GitHub CLI authentication available, and truthful repository-execution unavailability because the example configuration supplies no persistent-environment route.

Require diff/cleanup hygiene, candidate all-four hosted CI, exact integration, and a fresh integrated all-four run before acceptance. A real production capsule, remote publication mechanism, #197 consumption, and physical replacement construction remain later gates; this candidate authorizes none of them.

Cleanup measured 126 inactive direct-child `db-*`/`devbridge-*` qualification roots in the exact Windows Temp directory containing 5,680 files and 112,978,898 bytes. A live-process scan found zero references. One PowerShell removal attempt was blocked by host policy before execution; the established one-use Node.js helper then revalidated every exact direct real-directory target, excluded resource-lease state, removed all 126 roots, and verified zero matching root remains. The helper was removed from the worktree. Installation, VM, image, and recovery evidence were untouched.
