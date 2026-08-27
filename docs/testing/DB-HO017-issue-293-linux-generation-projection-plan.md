# DB-HO017 — issue #293 Linux generation projection

Status: planned from exact `cuda-target` baseline `f614714bede7cc5eabf4a664583886d18b42f68d` on isolated branch `security/293-linux-generation-projection`.

## Assessment

DB-HO012 through DB-HO016 now provide separate owners for protected path/file mutation, descriptor-bound transfer, durable lifecycle ownership/transaction records, and an atomic generic working-tree-to-installed-tree transaction. The measured protected-runtime candidate already supplies one exact package snapshot and one exact executable. The Linux lifecycle plan already derives the corresponding content-addressed generation and exact installed paths.

The missing dependency is composition, not another filesystem primitive. Nothing currently projects the local candidate into the generic tree contract, writes the bounded generation manifest through that transaction, or updates `stagedGeneration` only after the complete installed tree is reverified. Adding this knowledge to `linux-protected-tree.js` would leak lifecycle topology into a reusable module. Reimplementing copy, rename, or record persistence in a lifecycle controller would create competing effect owners.

## Research

This slice introduces no new operating-system effect. It reuses the primary-source findings and qualified lower contracts recorded in DB-HO012, DB-HO013, DB-HO015, and DB-HO016:

- Linux `rename(2)` provides the same-filesystem atomic directory-name transition used by the generic tree owner; an existing installed name must be verified or rejected rather than overwritten.
- `fsync(2)` requires explicit directory synchronization for directory-entry durability; the tree owner already synchronizes both working and installed parents.
- Linux path resolution follows symbolic links in non-final components without stronger descriptor-relative controls; the lower owners therefore require a protected parent chain and no-follow observation/transfer at each managed entry.
- Node's filesystem APIs expose the primitives already isolated behind the tree ports, while the measured-candidate owner bounds and hashes each package file and executable before this composition sees them.

Primary sources remain:

- [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- [Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html)
- [Linux path resolution](https://man7.org/linux/man-pages/man7/path_resolution.7.html)
- [Node.js v22 filesystem API](https://nodejs.org/download/release/latest-v22.x/docs/api/fs.html)

## Reassessment and ownership boundary

One Linux lifecycle-local generation brick will own only the mapping and ordering between existing contracts:

1. strictly normalize a measured package snapshot, executable evidence, source roots, bound lifecycle plan, and established ownership port;
2. derive one canonical generation manifest from the exact bound plan;
3. project declared package directories and files plus the executable and manifest into the neutral protected-tree request;
4. delegate all filesystem effects and final byte/policy verification to the existing tree owner;
5. load the exact lifecycle ownership record and reject missing numeric identity, a conflicting staged generation, or retained-generation aliasing;
6. update `stagedGeneration` only after the tree transaction returns exact installed evidence;
7. reconcile a crash after tree publication but before the ownership update by verifying the existing installed tree and then completing only the record update.

The brick will not know account commands, systemd operations, elevation, libvirt, qemu, qcow2, repositories, VMs, Windows, setup UI, or shared refresh-state-machine effects. Its public inputs describe only its local plan, measured bytes, source locations, creator identity, and ownership/tree ports. The generic tree and record modules remain unchanged.

## Plan

1. Move the Linux generation-manifest schema out of the read-only inspector into the generation owner so construction and inspection share one canonical protocol and normalizer.
2. Add a pure projection that validates exact candidate evidence, normalizes every package-relative path, declares the complete directory topology, emits bounded transfer entries for package files and the executable, and emits one canonical manifest content entry.
3. Add the narrow staging effect that requires an established immutable numeric identity, rejects ambiguous ownership state before mutation, delegates the tree transaction, and saves `stagedGeneration` last.
4. Prove pure shape, exact manifest, strict candidate/path/schema rejection, fresh installation, true no-op, tree-published/record-missing recovery, conflicting ownership state, source drift delegation, installed collision, ownership-save interruption, and source-module isolation.
5. Keep physical filesystem qualification in the generic lower owner. Its Ubuntu canary already proves the exact storage/tree effects with the current disposable test identity. This lifecycle projection is required to fix root ownership and must not add a configurable production owner merely to rerun the same canary without root. Hosted tests will instead prove exact request compatibility through injected lower ports; later bounded elevated setup tests will exercise the root-owned composition.
6. Run focused tests, preflight, repository-execution architecture gates, and the full suite. Publish only this isolated branch, update issue #293, and keep it open for identity/unit/service mechanics, one-command elevation, provider authorization, and physical KVM/libvirt/qcow2 qualification.

No UAC, sudo, account, systemd, libvirt, VM, production-image, or current-host authority mutation belongs to this slice.
