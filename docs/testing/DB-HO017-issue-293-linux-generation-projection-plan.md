# DB-HO017 — issue #293 Linux generation projection

Status: implementation and local qualification complete from exact `cuda-target` baseline `f614714bede7cc5eabf4a664583886d18b42f68d` on isolated branch `security/293-linux-generation-projection`; exact-head hosted CI remains required before integration.

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

## Implementation

`linux-lifecycle-authority-generation.js` now owns the Linux generation schema and the narrow composition between existing contracts. It:

- reconstructs the exact bound runtime plan from package/executable evidence and rejects widened modes or escaped runtime topology;
- strictly validates the measured candidate's closed object shape, file count/size bounds, normalized `package.json`/`src/**` paths, unique required service entry, per-file digests, aggregate package digest, executable evidence, and exact plan equality;
- fixes protected runtime custody to numeric root identity with `0755` directories, `0444` data/source files, and a `0555` executable rather than exposing a configurable owner for test convenience;
- emits one canonical bounded generation manifest shared by construction and read-only inspection;
- projects only neutral parent, working/installed tree, directory, transfer, content, and local state contracts; the module imports no tree implementation or provider/service/setup mechanics;
- requires an established ownership claim with immutable numeric identity before mutation;
- rejects another staged generation, retained-generation aliasing, and attempts to restage the active generation;
- delegates protected-parent preparation and the complete tree transaction through injected action ports;
- writes `stagedGeneration` only after exact installed-tree evidence returns;
- recovers a crash after tree publication but before the ownership update by reusing the verified installed tree and completing only the missing exact record write.

The read-only inspector now consumes the generation owner's canonical normalizer. The former inspector-local schema and compatibility re-export were removed rather than retained as legacy surface.

The new tests plug the projected request into the real generic `installLinuxProtectedTree` stud through in-memory filesystem ports. This proves the connection without adding lifecycle vocabulary to the generic owner or importing its implementation into the projection module. The generic lower owner's existing Ubuntu filesystem canary remains the physical storage proof; this root-fixed lifecycle layer does not weaken production ownership merely to duplicate it under an unprivileged test identity.

## Local qualification

Exact Windows-host evidence before publication:

- focused generation/inspection/records/tree suite: 34 tests, 33 passed, 1 existing Linux-only skip, 0 failed;
- repository preflight: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 40`), including the new generation boundary suite;
- VM/repository-execution LEGO architecture selection: 21 passed, 0 failed;
- full suite: 1,231 tests, 1,220 passed, 11 expected platform skips, 0 failed.

No elevation prompt, account/service/provider command, VM action, protected production path, or #197 physical canary state was touched. Issue #293 remains open for identity/unit/service effect composition, one-command elevated Linux re-entry, provider authorization, and real KVM/libvirt/qcow2 qualification.
