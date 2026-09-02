# DB-HO126 — issue #417 signed first-byte acquisition

Date: 2026-09-02

Status: implemented and locally qualified; hosted acceptance pending

Coordinates with: #159, #180, #290, #417, DB-003, DB-008, DB-009, DB-011, DB-013, DB-019, DB-HO124, and DB-HO125.

## Accepted predecessor and present defect

DB-HO125 candidate `21765ae60c9aa878ef608baa8b2a89de978afc7b` passed all four pull-request jobs on run `33613914637` attempt 2. Attempt 1's Windows bounded-preflight step expiry is separately recorded under #290. PR #448 rebase-merged as exact Stage 8 head `ce0528ab6d0713d4384bb0578bf3e14e18c26703`; candidate and merge trees are identical at `9ce35f3649ce0d2eecf6d0e6165c21a1aac45846`. Fresh Stage 8 run `33614757117` passed all four jobs.

The accepted immutable-object acquisition and HTTPS/filesystem sources now make exact bytes independently available, but the live zero-state frontier still downloads `bootstrap-devbridge.mjs` from one raw URL and imports it after only an HTTPS/status/size check. The commit-shaped URL is useful routing evidence, not signed byte authority. The downloaded stage and helper remain separate later source-integration work; this slice fixes only the first executable byte boundary.

## Governing authority

DB-003 keeps filesystem, network-source, executable, and signing policy local. DB-008 and DB-011 require exact supply-chain subjects and signature/digest verification before candidate code gains authority. DB-009 requires acquisition restart to reconcile exact physical state. DB-013 keeps a controller or remote source from granting executable/path policy. DB-019 makes bootstrap/release changes a full-qualification trigger while preserving focused evidence before the expensive suite.

The release-input manifest is therefore a signed child of release authority, not an origin manifest and not another runtime supervisor. It binds one exact repository head to one normalized immutable object set containing exactly `bootstrap-devbridge.mjs`. The starting local command supplies the exact manifest SHA-256, exact public-key SHA-256, expected key identifier, local manifest/key locations, local cache, ordered source policy, and the bootstrap arguments. Origins supply digest-addressed bytes only.

## Primary-source research and reassessment

Node.js 22.16.0 documents Ed25519 key identity through `KeyObject.asymmetricKeyType`, public-key parsing through `crypto.createPublicKey()`, and one-shot verification through `crypto.verify()`. For Ed25519 the algorithm argument is `null`: <https://nodejs.org/download/release/v22.16.0/docs/api/crypto.html>. Node also supports `data:text/javascript` ECMAScript-module imports, which lets verified exact bytes execute without a second path lookup: <https://nodejs.org/download/release/v22.16.0/docs/api/esm.html#data-imports>. The Fetch Standard defines redirect mode as the caller-selected choice to follow, return, or error; the accepted HTTPS source uses `error`: <https://fetch.spec.whatwg.org/#concept-request-redirect-mode>.

Reassessment rejects three tempting shortcuts:

- A commit-specific raw URL is not byte authentication.
- A manifest fetched from the same origin without a pinned digest/key is not independent authority.
- Reusing DB-011's runtime artifact manifest unchanged would collapse the deliberately small first-byte artifact into runtime activation and LKG ownership.

The smallest complete design is one signed first-byte descriptor verifier, one executor over the already accepted acquisition port, and one standalone local composition. The first-byte manifest carries no origins, URLs, local paths, cache policy, setup request, package, provider, or VM identity.

## Nested LEGO design

### Signed descriptor child

`devbridge/first-byte-release-manifest-v1` carries one Ed25519 signature over `devbridge/first-byte-release-subject-v1`. The signed subject binds the fixed DevBridge repository, exact 40-hex head, bounded release identity/sequence, and SHA-256 of one normalized `devbridge/immutable-object-set-v1` descriptor. The descriptor subject is deterministically bound to the exact head and contains exactly one bounded bootstrap object. The verifier additionally requires caller-pinned manifest bytes, public-key bytes, and key identifier before parsing or accepting the signature.

### First-byte executor

The executor owns only:

```text
pinned signed first-byte authority
  -> immutable-object acquisition port
  -> descriptor/result re-observation
  -> exact cache-file re-verification
  -> data import
  -> zero-state bootstrap call
```

It does not construct sources, choose local paths, parse CLI policy, run setup itself, fetch repository source, select packages, or know a provider. A forged acquisition result, cache substitution, wrong module shape, signature mismatch, digest mismatch, or all-sources-down result fails before import.

### Standalone composition

One generated standalone entry parses a closed local-only command contract, safely reads the manifest/key files, constructs ordered HTTPS/filesystem sources, creates the existing immutable acquisition child, and invokes the executor. HTTPS use requires an explicit bounded source duration; no default or changed timeout is introduced. Arguments after `--` are passed unchanged to the existing zero-state bootstrap parser. The existing direct data-import bootstrap path remains compatible while a private process marker prevents the parent composition from triggering it twice.

The trusted distribution command must itself pin the standalone first-byte loader's exact SHA-256 before import. That final command publication is release-output work; it cannot be inferred from a repository commit or moving branch.

## Test-first and qualification plan

1. Add failing contracts for signed descriptor normalization, exact manifest/key identity, signature verification, and rejection of widened first-byte objects.
2. Add failing executor tests proving primary-down secondary success, offline-only blank-cache success, all-sources-down typing, corrupt bytes, forged acquisition results, cache substitution, and import strictly after verification.
3. Add the closed standalone CLI contract and generated artifact, including explicit duration/source ordering and direct data-import compatibility.
4. Add LEGO scans proving the signed descriptor excludes origin/path/package/setup/provider identity and the executor depends only on verification, acquisition, exact-byte observation, and loading.
5. Run the focused first-byte/immutable-object/Stage-0/standalone/release-integrity families, generated-artifact check, preflight, architecture/product/standalone gates, exact Node.js 22.16.0 complete serialized suite, doctor, and diff hygiene.
6. Remove every attributable runtime, TAP file, and test root; require zero matching roots/processes.
7. Publish one isolated PR, require all four jobs, rebase-merge exact, and require a fresh all-four Stage 8 run.

This slice makes the first downloaded executable artifact cryptographically authorized and source-replaceable. It deliberately does not yet produce or publish a real release manifest, change exact DevBridge source acquisition, create Ubuntu binary/source capsules, wire setup/construction, bind the canonical installation, request UAC, or retry physical setup.

## Local implementation checkpoint

The implementation now has three deliberately separate owners: the signed release-input verifier, the executor over the accepted immutable acquisition port, and the standalone local CLI composition. The executor has no bootstrap dependency-injection escape hatch; it re-observes descriptor evidence and exact cache bytes before importing the authorized module. The CLI recognizes only its closed value-bearing option set before it reads a value, so bootstrap options cannot leak across the required `--` boundary.

The standalone builder now produces three artifacts, including `first-byte-devbridge.mjs`; repository preflight syntax-checks the new source and generated files and runs all four first-byte test families. Regeneration is exact. The final focused first-byte set passes 15/15, including proof that `--help` after the delimiter belongs to Stage 0 rather than the first-byte parser. The broader first-byte/immutable-object/Stage-0/standalone/release-integrity selection passes 78/78.

Current-runtime preflight passes three artifacts / 261 syntax files / two JSON files / 211 selected test files. The combined repository-execution architecture/product/standalone gate passes 37 total / 36 passed / one expected Windows symlink skip. Exact Node.js 22.16.0 doctor is green with GitHub admission and native C/CMake/CTest available while repository execution remains truthfully unavailable because construction is still outside this slice. The final exact-minimum serialized suite passes 2,184 total / 2,163 passed / 21 expected Windows skips / zero failed / zero cancelled in 329.573 seconds. Diff and generated-artifact hygiene pass.

Local cleanup removed both checked Node runtime copies and TAP records plus the accumulated DevBridge test-prefix backlog. More than 18,000 test/qualification roots were removed; measured subsets accounted for more than 507 MB of file payload, in addition to directory-table overhead. The final audit reports zero `db-*`, `devbridge-*`, or `pp-*` Temp roots and both qualification runtime/TAP paths absent. Passing-suite fixture leakage is now independently owned by #449 so this security slice does not absorb a repository-wide test-infrastructure refactor.

No setup, UAC, protected host, package, provider, construction, canonical installation, or physical retry occurred. Publish one isolated candidate, require all four pull-request jobs, merge only the exact accepted tree, and require a fresh all-four Stage 8 run before advancing to source-bundle integration.
