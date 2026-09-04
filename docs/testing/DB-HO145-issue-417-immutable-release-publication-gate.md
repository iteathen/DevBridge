# DB-HO145 — issue #417 immutable release publication gate

Date: 2026-09-04

Status: locally qualified candidate; hosted qualification pending

Coordinates with: #159, #178, #197, #417, DB-003, DB-008, DB-009, DB-017, DB-019, and DB-HO124 through DB-HO144.

## Accepted predecessor and exact seam

DB-HO144 merged through PR #470 as exact Stage 8 head `d56d26f2428b6f79de4479830b1c03b3f740c70f`. Candidate run `33910465185` and fresh integrated run `33910884954` each passed all four Ubuntu/Windows smoke and full jobs.

The accepted stack can produce a signed Ubuntu package capsule and reacquire every descriptor-bound object from replaceable origins or an offline directory. The unowned seam is publication ordering: every configured production destination must receive exact immutable objects, those bytes must be read back through the accepted acquisition boundary, and only then may public authority material and the signed manifest become visible.

## Research and reassessment

Current GitHub CLI documentation provides explicit Release asset upload/download operations and release-asset attestation verification. GitHub is still one provider/failure domain, so a GitHub adapter cannot prove origin independence by itself. The core publication owner therefore accepts replaceable destination ports and exact destination identities; deployment policy owns which destinations are independent and which credentials they use.

The signed DevBridge manifest remains release authority. Provider attestations may add provenance evidence but do not replace the caller-pinned manifest digest/key identity or make provider metadata authoritative.

Primary references:

- <https://cli.github.com/manual/gh_release_upload>
- <https://cli.github.com/manual/gh_release_download>
- <https://cli.github.com/manual/gh_release_verify-asset>
- <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>

## LEGO plan

Add one transport-neutral immutable release publication gate. It accepts only:

1. normalized immutable object descriptors;
2. exact local chunk locations covering those descriptors once;
3. bounded public authority prerequisites;
4. one bounded authority commit object that becomes visible last;
5. unique destination identities with narrow object-publication, immutable byte-source read-back, authority-publication, and authority-read ports; and
6. optional cancellation.

The gate validates exact descriptor/chunk coverage before any effect. It publishes all objects to every destination, directly streams every chunk back through that destination's accepted immutable byte-source port, independently counts and hashes those returned bytes, publishes and reads back all authority prerequisites at every destination, then publishes and reads back the commit object at every destination. Direct source read-back is required because a pre-populated acquisition cache could otherwise mask bad destination bytes. A failure before the commit phase must make zero commit-publication calls. Restart safety comes from destination-owned idempotent exact publication plus read-back reconciliation; the gate adds no generic retry or timeout.

Destination identity is an explicit receipt, not proof of an independent failure domain. Concrete composition policy must require appropriately independent destinations. GitHub Releases, another object provider, filesystem/LAN media, and offline bundles remain adapters outside this core.

## Test plan and exclusions

- Publish a multi-chunk descriptor through two distinct destination fakes backed by separate filesystem origins; prove direct exact source read-backs and global authority-last ordering.
- Reject missing/extra/duplicate chunk coverage, forged acquisition evidence, authority substitution, duplicate destination identities, unknown fields, and pre-aborted work.
- Fail one destination before object verification and prove neither destination receives the authority commit.
- Prove the gate source contains no GitHub, Ubuntu, provider, credential, setup, VM, or construction identity.
- Run focused proof, preflight, architecture/product/standalone gates, exact Node.js 22.16.0 full suite, doctor, cleanup, candidate all-four CI, exact integration, and fresh integrated all-four CI.

This slice does not implement a GitHub or second-provider uploader, create credentials or signing keys, produce or retain a real capsule, publish a release, select a channel pointer, connect #197, or mutate setup/services/PATH/ACL/provider/VM/physical-host state. Those effects require accepted concrete adapters and exact release authority. No physical retry is authorized here.

## Implemented boundary and reassessment

`ImmutableReleasePublicationGate` implements the transport-neutral coordinator. It normalizes unique descriptor subjects and digests, requires exact unique local chunk coverage, independently re-observes every local source file, and exposes only narrow destination ports for idempotent object publication, immutable-source read-back, public authority publication, and authority read-back. Public authority byte arrays are copied per destination so one adapter cannot mutate another destination's input.

The first focused implementation delegated read-back to an injected acquisition cache. Review rejected that design because a pre-populated correct cache could conceal corrupt or missing bytes at the destination being qualified. The final implementation calls each destination's immutable byte-source port directly for every unique chunk, consumes the complete stream, and independently enforces exact byte count and SHA-256 before any authority publication. This correction weakens no validation and adds no timing behavior.

The gate publishes and verifies all authority prerequisites at every destination only after every object read-back passes. It then publishes and verifies the commit authority at each destination. A failure at local admission, object publication/read-back, or prerequisite publication/read-back results in zero commit calls.

## Local evidence

Node.js 24 diagnostic focused proof passes 48/48. Diagnostic preflight passes 3 standalone artifacts / 284 syntax files / 2 JSON files / 225 dependency-selected tests.

Exact Node.js 22.16.0 qualification uses a single-link 85,119,640-byte runtime with SHA-256 `c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19` and passes:

- affected immutable publication/acquisition/source/capsule/source-bundle proof: 48/48;
- bounded repository preflight: 3 standalone artifacts / 284 syntax files / 2 JSON files / 225 dependency-selected tests;
- repository architecture, product identity, and standalone launcher proof: 37 total / 36 passed / one expected Windows symlink skip / zero failed;
- final complete serialized suite: 2,276 total / 2,254 passed / 22 expected skips / zero failed or cancelled in 386.507 seconds; and
- example-configuration doctor: exit zero with `ok: true`, GitHub CLI authentication available, and truthful repository-execution unavailability because no persistent-environment route is configured.

An earlier full run before the final descriptor-uniqueness and per-destination authority-copy hardening also passed 2,276/2,254/22 in 395.688 seconds, but it is superseded and is not the candidate qualification result. Require cleanup/diff hygiene, candidate all-four CI, exact integration, and fresh integrated all-four CI before acceptance.

Cleanup measured 219 inactive direct-child `db-*`/`devbridge-*` qualification roots in the exact Windows Temp directory containing 10,336 files and 135,146,229 bytes. A live-process scan found zero references. The one-use Node.js helper revalidated every exact direct real-directory target, excluded resource-lease state, removed all 219 roots, and verified zero matching root remains; the helper was then removed from the worktree. Installation, VM, image, and recovery evidence were untouched.
