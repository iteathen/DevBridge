# DB-HO100 — Permanent Entry ownership-receipt primitive

Date: 2026-08-30

Status: assessed and planned; no production producer or removal route exists

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
