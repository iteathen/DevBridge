# DB-HO127 — issue #417 exact source-bundle integration

Date: 2026-09-02

Status: local implementation and qualification complete; hosted acceptance pending

Coordinates with: #159, #180, #417, DB-003, DB-008, DB-009, DB-011, DB-017, DB-019, DB-020, DB-HO124, DB-HO125, and DB-HO126.

## Accepted predecessor and remaining source gap

DB-HO126 merged through PR #450 as exact Stage 8 head `1a640ee019a220b4649dea3ae2e633e1ac207dda`. Its candidate and integrated trees are identical at `c76cd5e46665865d3a33c8a25a8dccfb7920cbb5`. Fresh post-integration run `33622158482` passed Ubuntu smoke/full plus doctor and Windows smoke/full plus doctor.

The first executable bytes can now be authorized by a caller-pinned Ed25519 manifest and acquired through the neutral multi-origin/offline immutable-object port. The next stage still obtains the DevBridge source needed by Permanent Entry and runtime management through one live GitHub path:

- zero-state installation fetches a fixed list of component files individually from the raw host;
- development Permanent Entry checkouts fetch the exact commit from the fixed Git remote;
- runtime bootstrap/candidate preparation clones or fetches from that same remote;
- production Permanent Entry fetches one exact runner file through the GitHub contents API.

Those consumers have valid local subject/cache/activation ownership, but transport loss can still prevent a blank-cache install or recovery. The source-bundle slice must supply exact verified source bytes beneath those owners without becoming another selector, runner cache, runtime supervisor, or Git publication authority.

## Overlap and ownership assessment

Open-issue searches for source bundle, Git bundle, and runtime source identify #417 as the combined availability owner. #159 retains Permanent Entry selector, signed runner-subject, exact cache/LKG, and launch authority. #180 retains whole-application recovery composition. #168 is an unrelated deterministic `input.materialize` capability probe. #178 owns image transport and cache mechanics, not DevBridge source. DB-011 retains runtime release, validation, activation, and rollback authority.

This slice therefore owns only:

```text
signed exact DevBridge source subject
  -> one immutable Git-bundle object descriptor
  -> existing immutable acquisition port
  -> stable exact cache-file re-observation
  -> hardened local Git materialization
  -> exact commit/tree/clean-worktree observation
```

The source subject owns the fixed repository identity, exact commit, exact tree, release identity/sequence, Git-bundle format, and immutable-object descriptor digest. Origin URLs, local cache/materialization paths, Git executable identity, selectors, setup, packages, providers, VMs, and activation state remain outside it.

The materializer consumes narrow acquisition and command ports. It does not resolve moving refs, choose an origin, accept arbitrary refspecs, update a live runtime, launch source code, publish Git state, or own LKG policy. Existing consumers keep their own cache and lifecycle decisions.

## Primary-source research and reassessment

Git documents a bundle as refs plus Git objects suitable for offline transfer. A self-contained bundle created from one named ref contains all objects reachable from that ref and can be cloned into a repository without a network server. `git bundle verify` checks the bundle format and prerequisite completeness, while `git bundle list-heads` exposes the exact advertised ref: <https://git-scm.com/docs/git-bundle> and <https://git-scm.com/docs/bundle-format>.

GitHub documents that commit-addressed archives retain the same extracted file contents, but their outer compressed byte layout may change when archives are regenerated. It recommends release assets when the archive itself is security-sensitive: <https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives>.

Reassessment:

- Do not use GitHub's generated zip/tar bytes as the immutable source object; stable contents are insufficient when the signed descriptor binds exact transport bytes.
- Produce one self-contained Git bundle as a release artifact, hash/chunk it once, and replicate those exact bytes to every origin/offline bundle.
- Do not claim two independently produced bundles for one commit are byte-identical. Release production creates one object; distribution copies and verifies that object.
- Treat the bundle's advertised ref, commit object, tree, checked-out files, and clean state as separate observations after immutable-byte verification.
- A Git bundle is transport, not repository or release authority. The signed source subject supplies the only accepted head/tree and the consumer uses fixed Git operations with inherited credential/helper/hook authority suppressed.

## Nested LEGO plan

### Signed source authority

Add a `devbridge/source-bundle-release-manifest-v1` verifier whose signature covers a canonical `devbridge/source-bundle-release-subject-v1`. The subject binds:

- fixed repository `iteathen/DevBridge`;
- exact 40-hex commit and exact 40-hex tree;
- bounded release identity and monotonic release sequence;
- format `git-bundle-v2`;
- SHA-256 of one normalized immutable-object set containing exactly `devbridge-source.bundle`.

The caller pins manifest SHA-256, public-key SHA-256, and key ID exactly as at the accepted first-byte boundary. This is a signed child of release authority, not an origin-generated manifest and not a replacement for DB-011 runtime artifact identity.

### Verified materialization

Add one source materializer over two ports:

1. `acquisition.ensure({ descriptor, signal })` supplies the already verified content-addressed bundle object;
2. `commands.run(operation)` performs a closed set of hardened Git operations supplied by the composition adapter.

The materializer rechecks descriptor evidence and holds/re-hashes the exact cache file before any Git operation. It then verifies the bundle, requires exactly one fixed internal ref pointing to the signed head, initializes a separate destination, fetches only that ref from the local bundle, checks out the signed head detached, and observes exact `HEAD`, exact `HEAD^{tree}`, empty status, and the required DevBridge source shape. Failure removes only its newly created operation-owned destination; existing consumer state is untouched.

### Consumer adapters

Expose a narrow prepared-source result `{ head, tree, root }` that zero-state/Permanent Entry can consume through their existing prepared-source stud. Add a source port usable by exact checkout/runtime owners so their selection, receipts, candidate validation, activation, and LKG rules remain unchanged. Compatibility GitHub adapters remain explicit edge implementations until the release pipeline publishes real source-bundle manifests/objects; they are not silent fallback after a signed source bundle was selected.

## Local implementation checkpoint

The implemented child modules preserve the planned ownership split:

- `source-bundle-release-input.mjs` verifies the caller-pinned Ed25519 manifest/key identity and binds one normalized immutable Git-bundle object to the exact repository, commit, tree, release identity, and sequence;
- `source-bundle-materialization.mjs` consumes only acquisition and checkout ports, re-observes the acquired cache file, and requires returned head/tree/root evidence to equal the authorized request;
- `git-bundle-checkout.mjs` supplies the hardened Git edge, accepts only the fixed internal source ref, suppresses inherited Git configuration/credentials/hooks, proves a self-contained bundle in a new repository, and removes only its newly created destination on failure;
- `source-bundle-availability.mjs` exposes the same narrow exact-head source through `prepare` and `materialize` studs;
- Permanent Entry exact-checkout and DB-011 runtime-candidate preparation accept those optional studs while retaining their existing verification, receipt, candidate-validation, activation, and LKG ownership. Their direct GitHub paths remain explicit compatibility behavior when no source port is composed.

No production source bundle, release signature, or replicated release object was created by this slice. That publication work remains a later release-pipeline composition step; the local change establishes and qualifies the authority, acquisition, materialization, and consumer boundaries it must use.

Local evidence on exact Node.js 22.16.0:

- focused source-bundle/immutable/first-byte/Permanent Entry/runtime selection: 59/59 passed;
- bounded repository preflight: 3 standalone artifacts, 265 syntax files, 2 JSON files, and 213 targeted test files passed;
- repository-execution architecture plus product/standalone gates: 37 total, 36 passed, one expected Windows symlink skip;
- complete serialized suite: 2,196 total, 2,175 passed, 21 expected skips, zero failed, zero cancelled in 334.987 seconds;
- doctor: green, with repository execution truthfully unavailable until construction supplies a persistent execution route.

The full suite preceded only the final adversarial-test additions for multiple advertised refs, pre-aborted materialization, and dirty output. Those test-only additions then passed in the exact-version 59/59 focused run and the exact-version bounded preflight; production code did not change afterward.

## Test and acceptance plan

1. Prove exact manifest/key/signature/head/tree/format/descriptor binding and reject extra objects, fields, origins, paths, selectors, or package/provider concepts.
2. Prove primary-down secondary success, offline-only success, all-sources-down typing, forged acquisition evidence, cache substitution, malformed bundle, wrong/multiple advertised refs, wrong head/tree, dirty output, and operation interruption before prepared-source acceptance.
3. Prove the same fake acquisition/materialization ports can feed Permanent Entry prepared-source and runtime candidate source adapters without giving the source LEGO their cache/LKG/activation state.
4. Preserve existing direct GitHub development compatibility explicitly; no automatic fallback from a selected signed bundle to GitHub or a different source subject.
5. Run focused source/immutable/first-byte/Permanent Entry/runtime release tests, generated-artifact checks, preflight, architecture/product/standalone gates, exact Node.js 22.16.0 complete serialized suite, doctor, and diff hygiene.
6. Remove every attributable runtime, TAP file, and disposable test root; require zero matching Temp roots and no attributable process.
7. Publish one isolated PR, require all four hosted jobs, exact merge/tree equivalence, and a fresh all-four Stage 8 run before Ubuntu capsule work.

This slice changes no timeout, setup, UAC, protected service, package/snapshot selection, provider, VM, construction, canonical installation, or physical-host state. It does not authorize a setup retry. Ubuntu binary/source capsule production and #197 local-capsule consumption remain the next gates.
