# DB-HO013 — issue #293 Linux lifecycle records plan

Status: hosted candidate complete; exact-head CI pending. Implementation starts from exact `cuda-target` baseline `bcfae330cb223ed7705feff888bd9c9690c137e4` on isolated branch `security/293-linux-lifecycle-records`.

## Assessment

DB-HO012 established a topology-neutral Linux protected-storage primitive and its real-filesystem behavior passed Ubuntu CI in run `33118076373`. The next dependency is not account, systemd, libvirt, VM, or runtime mutation. It is the lifecycle owner's durable claim and transaction record boundary.

The current read-only inspector owns the ownership-record schema, while the shared reconciler owns the transaction schema. Neither currently supplies a Linux persistence port. Duplicating either schema in a filesystem adapter would create two authorities and make recovery depend on incidental JSON shape.

## Primary-source research and reassessment

Node documents that non-recursive `readdir` returns names excluding `.` and `..`, but also warns that directory-entry type information can disagree with `lstat` on some filesystems. POSIX further states that directory contents may change while a directory stream is being read. The claim path therefore uses names only as a bounded emptiness check; it does not infer entry type from directory enumeration. Exact files are always re-observed through the no-follow storage primitive immediately before mutation.

The atomic write, file flush, rename, and parent-directory sync findings recorded in DB-HO012 remain the persistence authority. This slice introduces no new direct filesystem mutation mechanism.

Primary sources:

- [Node.js filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [POSIX `readdir`](https://man7.org/linux/man-pages/man3/readdir.3p.html)

## Selected ownership boundary

One Linux lifecycle-record module owns only:

- the local ownership-record schema and canonical bytes;
- creation of its immediate root-owned directory hierarchy beneath a caller-established protected parent;
- the ownership and transaction files through the DB-HO012 storage contract;
- first-claim admission through an injected boolean decision;
- immutable numeric identity binding once recorded.

It does not know account commands, service managers, runtime trees, providers, repositories, VMs, or reconciliation effects. Transaction values are opaque to it and are accepted only through an injected normalizer. The Linux refresh composition will later attach the shared reconciliation journal normalizer at this stud.

## Plan

1. Extend the Linux plan with the exact immediate parent and module-owned storage-root paths plus a root-only transaction-file policy.
2. Move ownership normalization from the inspector into the lifecycle-record owner so read and write paths share one schema authority.
3. Export the shared transaction normalizer from its owning reconciler without changing reconciliation behavior.
4. Implement read-only load, admitted first claim, atomic ownership update, and opaque normalized transaction load/save over the existing storage primitive.
5. Prove absent, fresh, denied, resumed, foreign-entry, linked-file, interrupted-pending, numeric-drift, invalid-transaction, and no-op behavior while retaining DB-HO012's real-Linux filesystem evidence for the delegated storage effects.
6. Run focused tests, preflight, architecture gates, and the full suite. Publish only an isolated PR and keep issue #293 open.

No command in this plan mutates accounts, systemd, libvirt, qcow2, or the current Windows host. Physical Hyper-V v6 remains separately pending because elevation is unavailable.

## Implemented candidate

- The Linux plan now exposes the exact caller-owned storage parent, module-owned storage root, installation root, and root-only transaction-file policy. These are local path contracts, not provider or repository identities.
- Ownership normalization moved out of read-only inspection into the record owner, so reads and writes have one schema authority. Canonical output rejects unknown fields, root/aliased numeric identities, generation aliasing, foreign installation subjects, and more than eight retained generations.
- The shared reconciler exports its existing transaction normalizer. Reconciliation behavior did not change; the record owner receives the function through an opaque `normalizeTransaction` stud and contains no shared state-machine identity.
- First transaction save validates its value before mutation, observes the complete local record hierarchy, rejects foreign unclaimed entries, asks one injected admission decision, creates only immediate root-owned directories, persists the exact initial ownership claim, then persists the transaction.
- Existing claims resume without another admission. A recorded numeric identity cannot be cleared or rebound. Ownership and transaction files delegate all no-follow, pending-file, atomic replacement, flush, directory-sync, and final re-observation effects to DB-HO012.
- Loading remains read-only. A transaction without an ownership claim, linked/foreign record, invalid JSON/schema, invalid protected root, denied admission, or unexpected pre-claim entry fails closed.

The record brick imports no identity reconciler, service manager, runtime candidate, provider, repository, VM, or shared reconciliation effect. It is not yet attached to production Linux setup; no Linux readiness claim is made.

## Local verification evidence

1. Focused Linux plan/inspection/records plus shared reconciliation: 36 passed, 0 failed.
2. `npm run preflight`: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 36`).
3. Repository-execution architecture gates: 33 passed, 0 failed, 1 expected Windows symlink-capability skip.
4. Full `npm test`: 1,187 passed, 0 failed, 9 platform-capability skips; 1,196 total.

Exact-head Ubuntu and Windows CI remains required before integration. The next dependency after integration is immutable generation staging over the same claim/record boundary, followed by unit/service mechanics and only then setup/elevation and provider authorization.
