# DB-HO128 — issue #417 source-bundle release production

Date: 2026-09-02

Status: Windows path-identity correction locally qualified; fresh hosted acceptance pending

Coordinates with: #159, #178, #180, #417, DB-003, DB-008, DB-009, DB-011, DB-017, DB-019, DB-020, DB-HO124, DB-HO125, DB-HO126, and DB-HO127.

## Accepted predecessor and exact remaining seam

DB-HO127 merged through PR #451 as exact Stage 8 head `216d7963b80874a50d30a35dbb4fd7c68f050019`. Candidate and integrated trees are identical at `e9186c4fb2b6bbd038e3c7599b54b9ab22c209c3`. Fresh post-integration run `33626681985` passed all Ubuntu/Windows smoke/full plus doctor jobs.

The accepted consumer can verify a signed exact DevBridge source subject, acquire its immutable Git-bundle bytes from replaceable HTTPS/filesystem sources, and materialize the exact commit/tree into Permanent Entry or DB-011 runtime candidates. The remaining source-side gap is production of that signed subject and the exact digest-named object layout. Fixtures are evidence, not a release pipeline.

## Overlap and ownership assessment

Open source-bundle, Git-bundle, release-pipeline, and offline-bundle searches leave #417 as the only current owner. #159 still owns Permanent Entry selection/cache/LKG/launch, #180 owns whole-application recovery, DB-011 owns runtime acceptance/activation, and #178 owns image encoding/chunk publication. This slice reuses the neutral immutable-object value contract but does not teach image publication about DevBridge source or duplicate its image cache.

DB-HO128 owns only:

```text
clean canonical DevBridge repository at one exact HEAD
  -> one operation-owned self-contained fixed-ref Git bundle
  -> one measured/chunked immutable-object descriptor
  -> one caller-key-signed exact source manifest
  -> one local digest-named filesystem-origin layout
```

Remote-origin selection, credentials, upload APIs, release/channel pointers, setup, packages, snapshots, providers, VMs, construction, runtime activation, and accepted-runner state remain outside this owner.

## Research reassessment

The Git bundle and bundle-format research recorded in DB-HO127 remains authoritative: a bundle is refs plus reachable objects for offline transfer; `git bundle verify` checks format/prerequisites and `git bundle list-heads` exposes advertised refs. GitHub-generated commit archives do not promise stable outer compressed bytes, so the producer must create one bundle object and distribute exact copies rather than signing independently regenerated archives.

Reassessment for the producer:

- create a temporary bare repository and fetch the already observed local `HEAD` into the fixed `refs/heads/devbridge-source` ref; never add that ref to the authoritative working repository;
- create bundle version 2 once, then verify it against a separate empty bare repository so missing prerequisites cannot be satisfied accidentally by producer objects;
- re-observe canonical origin, exact HEAD/tree, and clean status after bundle creation to reject release-input drift;
- chunk and hash the already produced complete bundle; do not create one bundle independently per origin;
- make release signing authority an explicit local key input, verify the Ed25519 public/private pairing, and emit no secret bytes or secret-derived path in the result;
- publish only to a new caller-selected directory and clean only that operation-owned directory on failure.

Primary references:

- <https://git-scm.com/docs/git-bundle>
- <https://git-scm.com/docs/bundle-format>
- <https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives>

## Nested LEGO implementation

`GitSourceBundleProducer` owns the closed Git operation set. It suppresses inherited credentials/config/hooks and disallows extended protocols. It requires the exact canonical DevBridge origin, clean exact local HEAD, exact tree, fixed internal ref, version-2 bundle, successful empty-repository verification, exact ref/head/tree re-import, and unchanged source observations.

`buildSourceBundleRelease` owns byte measurement/chunking and signed release output. It refuses an existing destination, writes digest-named object leaves through exclusive temporary files, normalizes the immutable-object descriptor, signs the exact DB-HO127 payload using a caller-supplied matching Ed25519 keypair, and self-verifies the manifest before returning its pinned manifest/public-key digests.

`scripts/build-source-bundle-release.mjs` is a thin release-operator CLI. Every authority-bearing path and identity is explicit. It accepts no origin or upload option and prints only non-secret exact evidence. The package script is `npm run release:source-bundle --`.

## Test and acceptance plan

1. Prove a real multi-chunk produced release reacquires from the digest-named filesystem source and materializes through the already accepted DB-HO127 consumer to the exact clean head/tree.
2. Reject dirty/canonical-origin/head drift, mismatched signing keys, forged producer evidence, duplicated/unknown CLI options, unsafe key files, and pre-existing caller output.
3. Prove interruption/failure removes only the new operation directory and never mutates the source repository or caller-owned output.
4. Run source authority/producer/materializer/immutable acquisition tests, preflight, architecture/product/standalone gates, exact Node.js 22.16.0 serialized suite, doctor, and cleanup.
5. Require all four PR jobs, exact merge/tree equivalence, and a fresh all-four Stage 8 run.

This slice does not create or retain a real project release bundle or signing key and does not upload/publish any release object. Independent remote publication/verification and accepted release-pointer sequencing remain later #417 work. Ubuntu binary/source capsule production and #197 local-capsule consumption remain separate subsequent gates. No timeout, setup, UAC, protected-host, package/snapshot, provider, VM, construction, canonical-installation, or physical-retry action is authorized here.

## Local qualification checkpoint

Local evidence on exact Node.js 22.16.0:

- source release builder/CLI: 5/5 passed;
- source authority/producer/materializer selection: 15/15 passed;
- bounded repository preflight: 3 standalone artifacts, 268 syntax files, 2 JSON files, and 214 targeted test files passed;
- repository-execution architecture plus product/standalone gates: 37 total, 36 passed, one expected Windows symlink skip;
- complete serialized suite: 2,202 total, 2,181 passed, 21 expected skips, zero failed, zero cancelled in 342.952 seconds;
- doctor: green on Node.js 22.16.0, with repository execution truthfully unavailable until construction supplies a persistent execution route.

The tests create only disposable fixture repositories, ephemeral Ed25519 keys, and operation-owned release directories under the test Temp root. No project release artifact/key was retained or published.

## Hosted Windows correction

Pull-request run `33629919005` passed both Ubuntu jobs and failed only the Windows smoke/full jobs. All three failing release paths had one cause: the producer compared `realpath(repository)` to the caller spelling as exact text. GitHub-hosted Windows supplied the Temp repository through an 8.3 spelling such as `RUNNER~1`, while `realpath` returned the same directory under its long spelling. The producer therefore rejected a direct directory before checking its clean/head/origin contracts.

Use the existing neutral `sameFilesystemIdentity` LEGO for this boundary. It treats case and 8.3 spelling differences as the same Windows filesystem identity only after checking the path chain for symbolic entries and comparing the observed directory identity; POSIX remains exact-spelling and every symbolic-indirection rejection remains intact. The end-to-end release/materialization test now deliberately supplies a case-variant Windows spelling so raw text comparison cannot regress. This changes no timeout, Git operation, signing rule, origin policy, setup state, or physical host.

Correction qualification on exact Node.js 22.16.0 passes the direct producer/CLI set at 5/5, the broader source chain at 15/15, bounded preflight at 3 standalone artifacts / 268 syntax files / 2 JSON files / 214 targeted test files, and architecture/product/standalone at 37 total / 36 passed / one expected Windows symlink skip. The complete serialized suite passes 2,202 total / 2,181 passed / 21 expected skips / zero failed / zero cancelled in 346.476 seconds. Exact doctor is green and truthfully reports repository execution unavailable pending construction. Cleanup removed the verified 133,896,200-byte temporary Node runtime; all matching qualification roots and attributable processes are absent. Require one fresh complete hosted matrix before acceptance.
