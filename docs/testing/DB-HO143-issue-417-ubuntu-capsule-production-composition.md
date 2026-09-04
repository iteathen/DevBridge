# DB-HO143 — issue #417 Ubuntu package-capsule production composition

Date: 2026-09-04

Status: locally qualified candidate; hosted qualification pending

Coordinates with: #197, #417, DB-003, DB-008, DB-009, DB-019, and DB-HO124 through DB-HO142.

## Accepted predecessor and exact seam

DB-HO142 merged through PR #468 as exact Stage 8 head `6362f61bcca30ce66738eab87299fd372708a3a5`. Candidate CI `33903510501` and fresh integrated CI `33903915561` each passed all four Ubuntu/Windows smoke and full jobs.

The accepted stack has separate owners for immutable acquisition, bounded byte sources, signed Ubuntu capsule authority, exact APT no-removal solving, signed snapshot capture, Canonical verification, deterministic sealing, and a bounded concrete snapshot HTTPS source. The missing seam is one release-only coordinator that passes exact evidence through those existing studs without moving their decisions into setup or construction.

## Reassessment and correction

The first focused composition run exposed an existing contract defect: `UbuntuAptTransactionSolver.solve()` returns a normalized value containing its derived `transaction`, but `normalizeUbuntuAptTransactionSolution()` rejected that same value because it accepted only the pre-normalized fields. Fixture-shaped capture tests had not crossed the real solver-output boundary.

The correction makes normalization idempotent while remaining strict. A supplied derived transaction must contain only the canonical fields and must exactly match the protocols, base/result package-state digests, and ordered requested-package evidence recomputed from the package states. Changed or extra evidence still fails closed.

## LEGO contract

`UbuntuPackageCapsuleProducer` owns only orchestration:

1. require one explicit release policy and one exact immutable APT solver request;
2. reject snapshot or architecture split authority before invoking the solver;
3. normalize solver output immediately at the port boundary;
4. capture through the injected bounded archive source and Canonical verifier;
5. pass only the normalized capture/artifact set to the accepted sealer;
6. require exact release identity and destination evidence from the sealer; and
7. remove the completed operation-owned capture root on success or later sealing failure.

Capture and release destinations must be distinct non-nested absolute roots. The producer never removes caller-owned pre-existing output and delegates output admission/cleanup to the accepted capture and sealer owners.

The CLI composition wires only explicit concrete inputs: `UbuntuAptTransactionSolver`, `UbuntuSnapshotArchiveHttpsSource`, `GpgvInReleaseVerifier`, signing keys, recipe, and separate capture/release destinations. Its recipe contains only `policy` and `solverRequest`. The archive duration is explicit, bounded by DB-HO142, and is not a retry or liveness workaround.

## Preserved boundaries

The solver workspace is binding caller-provided release evidence. This slice does not create or mutate base dpkg state, APT lists, source selection, or requested package policy. A real production run still requires a qualified Ubuntu release environment containing the exact base status and immutable list files for the selected snapshot.

This slice does not choose a snapshot, add origin retry/fallback, publish remote objects, expose a moving release pointer, install packages, materialize a local construction repository, alter setup, elevate, touch services/PATH/ACLs, control a provider, or mutate a VM. #197 remains the sole construction consumer owner.

## Evidence and remaining gates

Current focused Windows proof passes 30 tests with one expected hosted-Linux `apt-get` skip and zero failures. This includes the real capture/seal/authority chain, exact port order, split-authority rejection, non-nested output policy, operation-owned capture cleanup after sealing failure, and solver-normalizer idempotence/substitution rejection.

Bounded repository preflight passes 3 standalone artifacts, 281 syntax files, 2 JSON files, and 222 dependency-selected tests. Repository architecture, product identity, and standalone launcher proof passes 36 of 37 tests with the one expected Windows symlink skip.

Exact Node.js 22.16.0 final local qualification passes:

- focused producer/capture/source/sealer/solver proof: 31 total, 30 passed, one expected hosted-Linux `apt-get` skip, zero failed;
- bounded repository preflight: 3 standalone artifacts, 281 syntax files, 2 JSON files, and 222 dependency-selected tests;
- repository architecture, product identity, and standalone launcher proof: 37 total, 36 passed, one expected Windows symlink skip, zero failed;
- complete serialized suite: 2,265 total, 2,243 passed, 22 expected skips, zero failed or cancelled in 380.736 seconds; and
- example-configuration doctor: exit zero with `ok: true`, exact runtime `v22.16.0`, and truthful repository-execution unavailability because the example configuration supplies no persistent-environment route.

A preceding Node.js 24.15.0 diagnostic full run also passed the same 2,265/2,243/22 result but is not counted as the exact qualification runtime. Before acceptance require diff and cleanup hygiene, candidate four-job CI, exact integration, and a fresh integrated four-job CI. Then produce and independently reacquire a real signed capsule through the separately owned immutable publication gate before #197 consumes it. No physical retry is authorized by this candidate.

Hygiene measured 852 inactive, direct-child `db-*`/`devbridge-*` qualification roots in Windows Temp containing 48,546 files and 313,776,919 bytes, including the independently SHA-256-verified 85,119,640-byte single-link Node.js 22.16.0 qualification copy. A live-process scan found zero references and no resource-lease root. Cleanup revalidated every target beneath the exact Windows Temp parent, removed the complete set, and verified zero matching root remains. The one-use cleanup helper was then removed from the worktree. Retained installation, VM, image, and recovery evidence were untouched.
