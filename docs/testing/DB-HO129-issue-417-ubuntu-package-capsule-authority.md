# DB-HO129 — issue #417 signed Ubuntu package/source capsule authority

Date: 2026-09-02

Status: local implementation and qualification complete; hosted acceptance pending

Coordinates with: #178, #192, #197, #200, #417, DB-003, DB-008, DB-009, DB-017, DB-019, DB-020, and DB-HO124 through DB-HO128.

## Accepted predecessor and remaining physical seam

DB-HO128 merged through PR #452 as exact Stage 8 head `fc1543f4e499426cd4c947057f728c7002f1b031`, with accepted tree `adfc4513d2dd646110f05d4dbf59b19b5ecc06d3`. Fresh post-integration run `33632903609` passed Ubuntu and Windows smoke/full plus doctor.

The accepted stack now has topology-neutral immutable-object acquisition, bounded HTTPS/filesystem sources, signed first-byte authority, signed exact DevBridge source authority/materialization, and source-bundle release production. Ubuntu construction still resolves only seven top-level versions from six live `Packages.gz` indexes and later runs live `apt-get --snapshot` update, upgrade, and install operations. A sealed release therefore still depends on `snapshot.ubuntu.com` for index and package bytes at installation time.

## Ownership and overlap assessment

Issue #417 remains the sole package-capsule availability owner. #197 owns Ubuntu construction and will later consume a sealed local repository/media adapter. #178 owns image encoding and transport-cache mechanics. #192/#200 own image publication/distribution policy. Setup and provider owners report or consume readiness but do not select package bytes.

DB-HO129 owns only:

```text
one exact Ubuntu release/snapshot/architecture/transaction subject
  -> Canonical signer plus InRelease/index object mapping
  -> complete binary transaction inventory and immutable object set
  -> exact binary-to-source mapping and source immutable object set
  -> one caller-key-signed capsule manifest
```

It does not fetch, solve, download, publish, cache, materialize, install, construct, activate, or clean any package. Producer capture is the next child; #197 consumption is a later child.

## Primary-source research and reassessment

Ubuntu snapshot identifiers fix archive state and are intended to be selected explicitly rather than from a later installation clock: <https://ubuntu.com/server/docs/how-to/software/snapshot-service/>.

APT's native trust chain is already the correct provenance model. A signed `InRelease`/`Release` authenticates exact index hashes; a `Packages` index carries the filename, size, and SHA-2 digest of each binary package; a `Sources` index carries source directory and SHA-2 records; and a `.dsc` identifies the complete source-package file set. The capsule must retain that chain instead of replacing it with only a DevBridge signature: <https://manpages.debian.org/testing/apt/apt-secure.8.en.html>, <https://wiki.debian.org/DebianRepository/Format>, and <https://www.debian.org/doc/debian-policy/ch-source.html>.

Reassessment:

- bind the fixed base, updates, and security pockets for `main` and `universe`, each with its exact `InRelease`, binary-index path/object, and source-index path/object;
- bind the exact base-media digest and a closed transaction protocol whose semantics are upgrade with new packages, no removals, and install without recommends;
- bind exact canonical pre-transaction and post-transaction installed-package-state digests so completeness cannot be claimed against another base state. `devbridge/dpkg-installed-package-state-v1` hashes the UTF-8 JSON array of installed `{package, architecture, version}` records sorted by package then architecture, with no trailing newline;
- require the complete binary inventory, not only requested top-level packages, and map every binary object to one exact source name/version;
- require one and only one source record for every referenced source name/version, with its `.dsc` and all referenced source objects;
- require exact object coverage in all three immutable sets—no unreferenced descriptor object and no inventory reference outside its set;
- sign normalized semantic digests while the caller independently pins the manifest digest, public-key digest, and key ID;
- keep origins and local paths outside the subject. Archive-relative paths are provenance values from signed Ubuntu indexes, not host filesystem authority.

## Nested LEGO plan

`ubuntu-package-capsule-release-input.mjs` is the Ubuntu-specific authority child. It composes the accepted topology-neutral immutable-object-set value contract and owns only Ubuntu/APT semantic normalization and signature verification.

The manifest binds:

- distribution `ubuntu`, exact release/codename/architecture/snapshot/base-media digest, release identity, and monotonic sequence;
- the exact accepted Ubuntu archive signing-key fingerprint;
- the closed transaction policy, exact pre/post installed-package-state digests, and sorted requested package/version set;
- a metadata descriptor plus fixed pocket/component/path/object inventory;
- a binary descriptor plus exact package/version/architecture/source/source-version/archive-path/object inventory;
- a source descriptor plus exact source/version/directory/`.dsc`/referenced-file inventory.

The signing payload contains the top-level release identity and SHA-256 digests of each normalized transaction, descriptor, and semantic inventory. The complete manifest bytes are also caller-pinned. This keeps signing deterministic while ensuring every semantic and byte-object change invalidates authority.

## Failure, recovery, and boundary behavior

- Unknown fields, moving identifiers, invalid archive-relative paths, mismatched pins/keys/signatures, missing requested binaries, missing binary/source mappings, duplicate identities, and incomplete or extra object coverage fail closed before any acquisition or package action.
- An origin cannot add a URL, redirect, path, signing key, snapshot, package, or verification rule because those fields are not accepted by this subject.
- Producer interruption cannot affect this pure verifier. The later producer must use DB-009 operation-owned staging and publish object bytes before the signed descriptor/pointer.
- Existing accepted setup, image, and installation state is untouched by this slice.

## Verification and acceptance plan

1. Accept one complete signed fixture and expose its exact normalized identities, mappings, descriptor digests, inventory digests, and pins.
2. Reject manifest/public-key/key-ID/signature drift and every unsupported authority-shaped field.
3. Reject pocket/component/index-path drift, descriptor extras/omissions, duplicate object use, requested-package omissions, binary/source mapping gaps, source extras, and unsafe archive paths.
4. Prove input ordering cannot change the canonical signing payload and prove the Ubuntu child contains no origin, setup, cache, provider, VM, or construction topology.
5. Run focused authority/immutable-object tests, bounded preflight, architecture/product/standalone gates, exact Node.js 22.16.0 serialized regression, doctor, and attributable-artifact cleanup.
6. Require all four hosted PR jobs, exact merge/tree equivalence, and a fresh all-four Stage 8 run before producer capture begins.

No real Ubuntu package/source bytes or signing key are created or retained. No remote publication, setup, UAC, protected-host, provider, VM, construction, canonical-installation, or physical retry is authorized by this slice. No timeout changes.

## Local qualification checkpoint

Local evidence on exact Node.js 22.16.0:

- focused capsule/immutable-object authority: 12/12 passed;
- bounded repository preflight: 3 standalone artifacts, 269 syntax files, 2 JSON files, and 215 selected test files passed;
- repository-execution architecture plus product/standalone gates: 37 total, 36 passed, one expected Windows symlink skip;
- complete serialized suite: 2,210 total, 2,189 passed, 21 expected skips, zero failed, zero cancelled in 357.757 seconds;
- doctor: `ok: true`, with repository execution truthfully unavailable until a constructed persistent environment exists.

The final contract correction rejects URI/drive-shaped and percent-encoded traversal archive paths and binds exact base-media plus canonical pre/post installed-package-state digests. The complete serialized suite was repeated after that production change; the evidence above is for the final candidate bytes. Test fixtures use ephemeral Ed25519 keys and synthetic descriptors only. No Ubuntu package/source/media object, project signing key, release artifact, or remote publication was created.
