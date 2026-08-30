# DB-HO100 — Permanent Entry ownership-receipt primitive

Date: 2026-08-30

Status: accepted primitive; no production producer or removal route exists

Coordinates with: #116, #159, #391, DB-003, DB-009, DB-011, DB-020, DB-HO095, DB-HO098, and DB-HO099.

GPU/CUDA work is outside this checkpoint.

## Scope and authority

This checkpoint owns the primitive durable record needed before the Permanent Entry installer can become a truthful application-inventory producer. It may add one neutral append-only exact-artifact receipt journal and prove its restart, corruption, contention, and generation behavior against disposable roots.

It does not own installer adoption policy, wrapper publication, component retention, mutation-lock composition, receipt retirement, application-removal operation rotation, a supported uninstall CLI, accepted-runtime/service/PATH/configuration producers, provider/environment purge, setup/elevation, protected service refresh, VM/guest lifecycle, repository execution, model invocation, or GPU/CUDA work. It must not remove or claim any live installed artifact.

## Accepted baseline and exact assessment

The isolated branch is clean and remote-equal at accepted documentation head `e77996ea646a5c4af9440ed16ea74dd6bf1623e3`. Exact implementation `34cdada887a8f327e77e08c5ea380c06ecb01a42` passed all four Ubuntu/Windows smoke/full jobs plus doctor in [GitHub Actions run 33316264686](https://github.com/iteathen/DevBridge/actions/runs/33316264686).

The accepted lower stack supplies a neutral application-removal contract/planner/coordinator, a serialized revisioned journal, exact artifact discovery/removal, a private-descriptor action bridge, and a restart-stable exact-artifact contributor. None of those bricks can manufacture provenance for the live Permanent Entry tree.

The installer audit found four distinct ownership classes:

1. Each exact component generation has an internal `.devbridge-entry-install.json` that binds its head, source endpoint, file list, byte counts, and SHA-256 values. That proves the component's current bytes; it is not an installation-wide ownership history.
2. `bin/devbridge-entry.mjs`, `bin/devbridge-entry.cmd`, `bin/devbridge-entry`, and the optional previous JavaScript entry have no durable sidecar receipt. Their reserved names and regular-file shape alone are not creation/adoption evidence.
3. `entry/staging` and `entry/quarantine` deliberately retain interruption or displaced-object evidence. Their contents cannot be inferred removable from directory names, age, or installer topology.
4. Older verified component generations are deliberately retained. The current selected head does not authorize deletion of the others, and an evolving component file list can make a newer verifier unsuitable as historical provenance by itself.

The installer serializes its own mutation with `entry/.install.lock`, stages component materialization separately, quarantines an invalid same-head target, and publishes the primary wrapper last. Those mechanics reduce activation risk, but no transaction currently records the complete exact set and provenance accepted by one installation generation.

Two wider recovery gaps follow:

- A reinstall after complete application removal may recreate identical bytes. Static removal item/journal identities would collide with immutable completed receipts unless a newly created installation epoch changes the operation subject.
- Retiring or replacing a receipt is itself an effect. Silently rewriting one current manifest would lose the evidence needed to distinguish an interrupted update from a new installation.

## Primary-source research

The [Node.js 22.16.0 filesystem contract](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fsfsyncsyncfd) says `fs.fsyncSync()` requests that all data for an open descriptor be flushed, with exact behavior depending on the operating system and device. The same version documents that [`writeFileSync(..., { flush: true })`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fswritefilesyncfile-data-options) invokes `fsyncSync()` after a successful write and that [`linkSync(existingPath, newPath)`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fslinksyncexistingpath-newpath) synchronously creates a hard link.

Microsoft documents that [`CreateHardLinkW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw) creates another directory entry for one file, supports files rather than directories, and requires every link to remain on one volume. It also documents that the file's security descriptor belongs to the underlying file rather than to an individual link.

Microsoft documents `MOVEFILE_REPLACE_EXISTING` and `MOVEFILE_WRITE_THROUGH` as separate [`MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) flags; write-through specifically describes flushing a move implemented as copy/delete. This does not justify treating a plain cross-platform rename as a complete power-loss transaction or as ownership evidence.

Reassessment: use a unique, never-replaced revision filename; write and flush complete bytes in caller-owned same-volume scratch; publish with create-if-absent hard-link semantics; remove only the exact temporary name created by that attempt; and reread the accepted revision exactly. Claim only process-restart reconciliation and exact observed acceptance. Do not claim filesystem-independent power-loss atomicity or directory-metadata durability that the cited APIs do not promise.

## Ownership reassessment

The receipt primitive owns only an immutable local record contract and journal mechanics. It must not know the Permanent Entry, wrapper, component, installer, runtime, service, setup, provider, repository, VM, or purge topology.

Each accepted record carries:

- one random installation epoch that survives revisions of the same journal and changes when a removed journal is freshly recreated;
- one strict contiguous revision and the SHA-256 of the preceding immutable revision;
- one deterministically derived generation for the exact epoch/revision/items;
- a bounded sorted set of neutral item identities;
- `created` or explicitly locally `adopted` provenance; and
- one bounded exact-JSON private value per item.

The journal may preserve an exact private artifact descriptor, but it does not decide that the descriptor is true. A later producer must re-observe the artifact through its owning verifier/action adapter immediately before projecting created/adopted state or binding deletion. Foreign/ambiguous state never becomes an accepted ownership item.

The journal directory contains only immutable numbered revisions. Temporary files stay in a separately supplied same-volume scratch root so an interrupted unpublished write cannot masquerade as accepted history. Missing, noncontiguous, extra, non-canonical, oversized, link-indirected, digest-conflicting, or chain-conflicting journal state fails closed.

The first production composition must separately design exact adoption. It may adopt only a complete statically verified current publication during an explicit local installer action; it must not overwrite an arbitrary regular file and then label the result created. That policy is deliberately not hidden inside this neutral journal.

## Primitive-to-high-level implementation plan

1. Add one import-isolated neutral exact-artifact receipt journal. Validate exact keys, bounded exact JSON, safe identities, created/adopted provenance, sorted uniqueness, epoch/revision/generation/previous-digest invariants, and canonical bytes.
2. Read a journal without creating it. Require real contained directories/files, numbered contiguous revisions, bounded file count/size, complete digest chaining, and exact canonical reread. Reject any unsupported entry rather than ignoring possible foreign evidence.
3. Accept through a caller-supplied same-volume scratch root. Flush one exclusive temporary file, publish one never-replaced revision with hard-link create-if-absent semantics, clean only the exact temporary artifact, and reread the complete journal. Reconcile an identical concurrent winner; otherwise retry from fresh observed history within a fixed bound.
4. Preserve the epoch across accepted changes; derive a fresh epoch only for a truly absent journal. Return the existing revision without a write when the sorted item set is identical. A newly recreated journal therefore produces a distinct generation even for identical artifact bytes.
5. Test fresh acceptance, idempotence, revision chaining, restart, fresh-recreation rotation, concurrent same/different proposals, corrupt/partial/noncanonical/extra/gapped history, unsupported provenance, duplicate/oversized/deep/non-JSON values, unsafe directory indirection, and cleanup of only the current attempt's scratch artifact.
6. Add source-level LEGO tests proving the module imports no project topology and contains no foreign owner identity. Register its tests in the explicit preflight inventory.
7. Run focused current and exact Node 22.16.0 tests, bounded preflight, architecture/product/standalone gates, complete exact serialized suite, doctor, diff hygiene, and exact-head hosted Ubuntu/Windows smoke/full plus doctor.
8. Document implementation evidence and keep #391 open. The next slice must assess and plan the Permanent Entry producer composition: exact static adoption, wrapper/component grouping, retained/corrupt generation handling, installer mutation activity, receipt self-inventory, and removal-operation rotation. Do not expose a production contributor or CLI before that composition is complete.

## Nonclaims

- A receipt value is private durable evidence, not permission to remove an unobserved or changed artifact.
- This slice does not declare any existing live installation artifact created or adopted.
- It does not retire the legacy Stage-0 entry/tree, staging residue, quarantine evidence, old components, runner/runtime generations, services, PATH changes, configuration, providers, images, environments, or VMs.
- It does not make application or purge coverage complete.
- It does not solve receipt retirement or completed-removal journal rotation by itself; the epoch merely provides the primitive identity needed by that later design.
- No failure enables repository-code host execution.

## Implementation

`src/runtime/exact-artifact-receipt.js` now supplies the planned import-isolated journal through two neutral ports: `read()` and `accept(items)`. It validates bounded exact-JSON private values, safe unique item identities, explicit `created`/`adopted` provenance, canonical item ordering, one UUID epoch, strict contiguous revisions, previous-record SHA-256 chaining, and deterministic generation identity. Returned records and all nested values are frozen.

Reading never creates state. It accepts only one real non-indirected journal directory containing canonical immutable numbered regular files with a single link, bounded size/count, and an exact complete digest chain. Extra entries, gaps, non-canonical bytes, malformed records, link aliases, structural overflow, and changed held-file observations fail closed.

Acceptance requires a separate caller-created real scratch directory. It writes one exclusive temporary file, flushes its held descriptor, creates the never-replaced revision through a hard link, removes only a temporary file actually created by that attempt, and rereads the journal. Identical input is idempotent. Concurrent identical proposals reconcile one accepted revision; different proposals serialize through immutable revisions within a fixed retry bound. Deleting and recreating the disposable journal rotates its epoch and therefore its generation even when item bytes are identical.

Node 22.16.0 on this Windows host reports a zero device identity through one of the path/held-handle APIs even when inode, size, link count, shape, and stable path observations match. The implementation therefore requires device equality everywhere except on Windows when either API reports zero; it never relaxes inode, size, link-count, regular-file, or before/after stability checks. A bounded five-millisecond retry permits readers to wait through the journal's own short hard-link publication interval while persistent link aliases remain rejected.

The publication mechanism does not claim filesystem-independent power-loss atomicity or directory-metadata durability. A process or machine failure after target-link creation but before temporary-link removal can leave a two-link accepted file that subsequently fails closed and requires exact operator reconciliation. This slice deliberately does not infer cleanup authority for an unrecorded scratch name.

The explicit repository preflight inventory includes the new source, functional tests, and LEGO regression. The LEGO test imports the source as a standalone data module and rejects local project imports or names belonging to an installer, component, service, repository, provider, VM, disk, or purge topology.

## Local qualification

Final candidate bytes passed:

- focused functional and LEGO tests on exact Node 22.16.0: 15/15;
- the same focused tests on the current Node runtime: 15/15;
- exact Node 22.16.0 bounded repository preflight: 2 standalone artifacts, 231 syntax files, 2 JSON files, and 190 targeted test files;
- repository-execution architecture plus product/standalone gates: 37 total, 36 passed, 1 expected Windows symlink-capability skip, 0 failed;
- exact Node 22.16.0 complete serialized suite: 2,010 total, 1,989 passed, 21 expected platform skips, 0 failed in 192.6 seconds;
- exact Node 22.16.0 doctor: `ok: true`, coding adapters disabled, repository execution unavailable/fail-closed because no routes are configured, and lifecycle `setup-reentry-required`;
- standalone artifact regeneration and Git diff hygiene: clean.

No setup, authentication/elevation, protected service/provider/storage, VM/guest, repository-code execution, model invocation, live installation/removal, or GPU/CUDA effect occurred. Commit and push this candidate only on the isolated branch, then require the exact-head Ubuntu/Windows smoke/full matrix plus doctor before accepting the primitive. Keep #391 open and do not wire a production producer or removal command from lower-brick test success alone.

## Hosted Windows path-spelling correction plan

[GitHub Actions run 33318238507](https://github.com/iteathen/DevBridge/actions/runs/33318238507) rejected candidate `0e95df9af390063940a6b76040f6032efdd7082e`: Ubuntu smoke/full passed, but all 12 receipt tests in both Windows bounded preflight and the serialized suite failed before journal use because the runner's lexical temp path contains `RUNNER~1` while `realpath()` returns the long `runneradmin` spelling. The existing equality test treated that spelling change as indirection.

Microsoft's [file-name contract](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#short-vs-long-names) says Windows may store a short 8.3 alias for a long name and documents `GetLongPathName` as the conversion from short to long form. Node 22.16.0 documents that [`realpath`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fsrealpathpath-options-callback) computes a canonical pathname but that a canonical pathname is not necessarily unique; it also documents that [`lstat`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromiseslstatpath-options) observes a symbolic link itself rather than its target. Microsoft separately documents that [junctions are reparse-point directory aliases](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions#junctions). Therefore string inequality is not sufficient evidence of indirection on Windows, while accepting an arbitrary alternate spelling would be unsafe.

Reassessment and scoped plan: keep the receipt module import-isolated. For Windows only, require equal volume roots, inspect every component of both spellings with `lstat`, reject any symbolic-link/junction evidence, and accept a different spelling only when both directory endpoints carry the same nonzero inode plus compatible device identity. Preserve strict canonical spelling equality on non-Windows platforms. Re-run focused current/exact tests, preflight, architecture/product/standalone, complete exact serialized suite, doctor, regeneration/diff hygiene, and a fresh exact-head hosted matrix. Do not rerun the rejected workflow as though it were acceptance.

Corrected local candidate evidence passes 15/15 focused tests on current and exact Node 22.16.0, preflight at 2 artifacts / 231 syntax / 2 JSON / 190 targeted files, architecture/product/standalone at 37 total / 36 passed / one expected Windows symlink skip, and the complete exact-Node serialized suite at 2,010 total / 1,989 passed / 21 expected skips / zero failures in 194.9 seconds. Exact doctor remains green and VM-route fail-closed; standalone regeneration and diff hygiene pass. Require a fresh exact-head hosted matrix to prove the `RUNNER~1` regression itself before accepting the candidate.

## Hosted acceptance

Exact corrected implementation `a4fa9b1b9a9aadebeb524af35b630dc3701574bf` passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor in [GitHub Actions run 33318685645](https://github.com/iteathen/DevBridge/actions/runs/33318685645). The Windows bounded preflight ran the receipt tests below the same `RUNNER~1` temp spelling that rejected the predecessor, so this run directly accepts the short/long same-object correction rather than merely relying on a local path without an alias.

Accept the neutral receipt-journal primitive. Keep #391 open. The next cycle must assess the production Permanent Entry producer and installer-lock composition; adoption policy, receipt self-inventory/retirement, removal-operation rotation, complete application/purge coverage, supported CLI, and protected/physical/GPU work remain unimplemented or separately gated. Require the documentation-only head to pass the complete matrix before starting that cycle.
