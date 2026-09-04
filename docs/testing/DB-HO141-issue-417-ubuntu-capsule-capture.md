# DB-HO141 — issue #417 Ubuntu capsule capture and construction consumption

Date: 2026-09-04

Status: physical failure classified; release-capture candidate locally qualified

Coordinates with: #197, #372, #417, DB-003, DB-008, DB-009, DB-017, DB-019, DB-020, and DB-HO124 through DB-HO140.

## Exact physical evidence

PR #466 qualified candidate `1dd3649bdac090416ed69a7f1fed0fcc011ade8b`; run `33888028374` passed Ubuntu and Windows smoke/full jobs. It rebase-merged into Stage 8 as exact head `df3aabf2b87d26c32eb9d0bb112a6ae877ceeabc`, tree `0d59e3200e56097d8116b25b34c30db09bfe3e36`, and fresh run `33888442701` passed the same four jobs.

One authorized ordinary, non-elevated setup entry constructed exact v9 subject `subject-1247bff6897985fec3dc476b055e05a3`, VM `db-image-build-c28af4e09490a172`, provider identity `b07051fd-b645-46c1-b972-1ed31983e5bb`, and disk `9acbd63c5f552f9cbac8e43a7773a9db4c6c6054062d89cfad9f39daf8120b2a.vhdx`. Allocation advanced to `9,600,761,856` bytes, then stopped changing at `2026-09-04T16:13:19.278Z`.

A later freshly authorized re-entry classified the subject `stalled` after 71 minutes, including 57 minutes without observed progress. It failed closed without retry or VM repair and published durable 320×240 console evidence SHA-256 `ed6ded8d4f15290eea5a80cbe17520394b9ad1bf36b1f17118bbc91dd91cc08b`.

The established exact-provider read-only 640×480 thumbnail diagnostic produced 614,404 RGB565 bytes, including the accepted four-byte zero terminal variant, at `2026-09-04T17:15:39Z`. Raw SHA-256 was `173a36e93e7a570cacbb4ab8013d2829b9a4857d7b9ec383bbca42173dfe3ad1`; the diagnostic PNG SHA-256 was `b84b9b2c373660f125f95033ca7b33bf98a1cc5b19dee60a7a508e3ee6d9bdd8`.

The higher-resolution console proves:

1. Subiquity completed its installer-owned postinstall work.
2. DevBridge's snapshot-bound late `apt-get update` completed.
3. The no-removal snapshot upgrade completed.
4. The exact-version `apt-get install --no-install-recommends` command failed.
5. Subiquity stopped at `An error occurred. Press enter to start a shell`.

The console does not expose APT's stderr, so it does not prove whether an origin response, a missing object, or another package-transaction condition caused the nonzero command. No cause narrower than the live package-delivery dependency is claimed.

No consent or credential UI process appeared during the authorized setup entry, so no UAC screen is claimed. No guest input, manual power action, media detach, disk mount, service/ACL/PATH change, timeout adjustment, retry, or state repair occurred. The exact failed VM and state remain preserved until their owning replacement/retention transitions can retire them.

## Ownership and overlap reassessment

Issue #417 already owns the missing origin-resilient release-input boundary. Its accepted sequence has delivered:

- DB-HO124: neutral immutable-object acquisition/cache;
- DB-HO125: bounded HTTPS and offline byte sources;
- DB-HO126: signed first-byte acquisition;
- DB-HO127/128: exact source-bundle consumption and release production;
- DB-HO129: signed Ubuntu binary/source capsule authority;
- DB-HO130: deterministic capsule verification and sealing; and
- DB-HO131: APT's exact no-removal upgrade/install transaction solver.

Do not open a competing issue, add an APT retry to image construction, extend the liveness deadline, change the accepted snapshot, loosen exact pins, repair the failed guest, or assign this failure to the new Hyper-V fcopy unit. The failed command precedes installed-guest fcopy qualification.

## Primitive-first implementation sequence

### 1. Release-time snapshot capture

Compose one Ubuntu-specific release adapter above DB-HO131 and below DB-HO130. It receives one explicit snapshot/release/base-media subject, one exact base dpkg state, the fixed requested package names, bounded Canonical archive access, and injected APT/GPG/signing ports. It:

1. captures the three fixed pocket `InRelease` files plus main/universe binary and source indexes;
2. verifies the Canonical signature and index hash chain before using records as authority;
3. asks DB-HO131 for the complete no-removal binary transaction;
4. maps every selected binary to one exact signed Packages record and every binary source to one exact signed Sources/`.dsc` closure;
5. acquires exact size/SHA-256-bound binary and source bytes into an operation-owned direct-file set; and
6. passes only the normalized capture and artifacts into DB-HO130 for deterministic sealing.

Archive origins supply bytes only. They do not select snapshot, release, package, source, signing key, destination, executable, or construction policy. Bounded diagnostics expose the failed exact object without turning retries into acceptance. Partial operation state remains separate from a sealed release and is removable by its owner.

### 2. Release publication and reacquisition

Publish object bytes to independently configured immutable origins and verify them back before publishing the signed manifest pointer. Prove secondary-only and offline-only reacquisition. A production capsule is not accepted from a test fixture or one unverified local directory.

### 3. #197 local-capsule consumer

After release-capture CI acceptance, add a separate construction-side consumer. It verifies the signed capsule through DB-HO129, reacquires its immutable objects through DB-HO124/125, materializes a read-only local APT repository/media projection, and binds its exact capsule identity into Ubuntu construction authority and recipe/output generations. The guest installs only from that local sealed input; after capsule admission it makes no request to `snapshot.ubuntu.com`.

The consumer does not select a snapshot, solve dependencies, trust an origin, sign a release, or own VM/provider behavior. Existing construction, qualification, sanitization, image publication, and lifecycle owners remain unchanged.

### 4. Physical replacement and cleanup

Require focused tests, repository preflight, architecture/product gates, complete suite, candidate four-job CI, exact integration, and fresh integrated four-job CI. Then use the supported retention transaction to retire the exact failed v9 subject before constructing its replacement. Keep one construction VM only. Run primary-denied and offline-only physical construction, then continue through environment reconciliation and the GitHub-delivered Linux/Windows Hello World proof.

## Current gate

The release-time capture candidate is implemented as `src/release/ubuntu-package-capsule-capture.mjs`. It accepts exact release policy plus one normalized DB-HO131 solution, reads through an injected origin-neutral archive port, verifies each InRelease signature and signed index identity before selecting artifacts, maps every solved binary to an exact source closure, writes only an operation-owned direct-file set, and composes successfully into the existing DB-HO130 sealer and DB-HO129 verifier. Archive paths and source filenames are validated before they can reach the reader port; setup, provider, construction, and concrete origin identities remain outside the LEGO.

Exact local Windows qualification on 2026-09-04:

- focused capture/solver/sealer/authority chain: 29 total, 28 passed, one expected Linux-only skip, zero failed;
- bounded repository preflight: 3 standalone artifacts, 278 syntax files, 2 JSON files, and 220 dependency-selected tests passed;
- repository-execution architecture gate: 34 total, 33 passed, one expected Windows symlink skip, zero failed;
- product identity: 1/1 passed;
- standalone installer regression: 2/2 passed;
- complete suite: 2,256 total, 2,234 passed, 22 expected skips, zero failed or cancelled in 73.463 seconds;
- example-configuration doctor: exit zero with `ok: true`; repository execution remained explicitly unavailable because the example configuration supplies no persistent-environment routes; and
- diff hygiene: clean apart from Git's advisory checkout line-ending warning.

Hosted candidate acceptance is now the gate. Physical retry remains prohibited until a real sealed capsule and construction consumer are accepted. The running failed v9 VM remains evidence, not a candidate for manual repair or a second parallel attempt.
